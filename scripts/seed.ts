/**
 * Bulk test-data seeder for pgqueue-control.
 *
 * Unlike demo/producer.ts (which drives real pg-boss workers in real time),
 * this inserts thousands of synthetic jobs directly via SQL so you get a
 * large, varied dataset (all states, dead-letter, historical stats) in
 * seconds instead of minutes.
 *
 * Usage:
 *   npm run seed
 *   SEED_JOBS_PER_QUEUE=20000 npm run seed
 */
import pg from 'pg';
import { PgBoss } from 'pg-boss';

const connectionString = requireEnv('DATABASE_URL');
const schema = process.env.PGBOSS_SCHEMA ?? 'pgboss';
const jobsPerQueue = Number(process.env.SEED_JOBS_PER_QUEUE ?? 5000);
const spreadDays = Number(process.env.SEED_SPREAD_DAYS ?? 14);

interface QueueSpec {
  name: string;
  retryLimit: number;
  /** Average job duration in seconds, for started_on/completed_on spread */
  avgDurationSeconds: number;
  deadLetter?: string;
}

const QUEUES: QueueSpec[] = [
  { name: 'agent-tasks-dlq', retryLimit: 0, avgDurationSeconds: 5 },
  { name: 'agent-tasks', retryLimit: 2, avgDurationSeconds: 8, deadLetter: 'agent-tasks-dlq' },
  { name: 'embeddings', retryLimit: 1, avgDurationSeconds: 1 },
  { name: 'notifications', retryLimit: 0, avgDurationSeconds: 0.5 },
];

async function main() {
  await bootstrapSchema();

  const pool = new pg.Pool({ connectionString, max: 5 });
  try {
    for (const queue of QUEUES) {
      const inserted = await seedQueue(pool, queue);
      console.log(`  ${queue.name}: +${inserted} jobs`);
    }

    const dlqInserted = await mirrorDeadLetterJobs(pool);
    console.log(`  agent-tasks-dlq: +${dlqInserted} mirrored from agent-tasks failures`);

    for (const queue of QUEUES) {
      await refreshQueueCounts(pool, queue.name);
    }
    console.log('Refreshed pgboss.queue counters');

    for (const queue of QUEUES) {
      const points = await seedQueueStatsHistory(pool, queue.name);
      console.log(`  ${queue.name}: +${points} queue_stats history points`);
    }
  } finally {
    await pool.end();
  }

  console.log('Done.');
}

/** Reuse pg-boss's own installer so the schema/enum/partitions match exactly what the app expects. */
async function bootstrapSchema(): Promise<void> {
  const boss = new PgBoss({ connectionString, schema });
  boss.on('error', (err: Error) => console.error('[pg-boss]', err.message));
  await boss.start();
  await boss.createQueue('agent-tasks-dlq');
  await boss.createQueue('agent-tasks', { retryLimit: 2, retryDelay: 2, deadLetter: 'agent-tasks-dlq' });
  await boss.createQueue('embeddings', { retryLimit: 1 });
  await boss.createQueue('notifications');
  await boss.stop({ graceful: false });
}

/**
 * Weighted-random state distribution, computed in a single SQL statement via
 * generate_series so the whole batch is one round trip regardless of size.
 */
async function seedQueue(pool: pg.Pool, queue: QueueSpec): Promise<number> {
  const { rowCount } = await pool.query(
    `
    INSERT INTO ${schema}.job
      (id, name, priority, data, state, retry_limit, retry_count,
       start_after, created_on, started_on, completed_on, keep_until, output)
    SELECT
      gen_random_uuid(),
      $1,
      (random() * 10)::int,
      jsonb_build_object('seed', true, 'i', g),
      state,
      $2::int AS retry_limit,
      CASE state WHEN 'retry' THEN 1 WHEN 'failed' THEN $2::int ELSE 0 END,
      created_on,
      created_on,
      CASE WHEN state IN ('created', 'retry') THEN NULL
           ELSE created_on + make_interval(secs => random() * $3::float) END,
      CASE WHEN state IN ('completed', 'cancelled', 'failed')
           THEN created_on + make_interval(secs => random() * $3::float + $3::float)
           ELSE NULL END,
      created_on + interval '30 days',
      CASE WHEN state = 'failed' THEN jsonb_build_object('message', 'seeded failure')
           WHEN state = 'completed' THEN jsonb_build_object('ok', true)
           ELSE NULL END
    FROM (
      SELECT
        g,
        now() - make_interval(secs => random() * $4::float * 86400) AS created_on,
        (CASE
          WHEN r < 0.60 THEN 'completed'
          WHEN r < 0.75 THEN 'active'
          WHEN r < 0.85 THEN 'created'
          WHEN r < 0.93 THEN 'retry'
          WHEN r < 0.98 THEN 'failed'
          ELSE 'cancelled'
        END)::${schema}.job_state AS state
      FROM (SELECT g, random() AS r FROM generate_series(1, $5::int) AS g) rows_with_r
    ) rows
    `,
    [queue.name, queue.retryLimit, queue.avgDurationSeconds, spreadDays, jobsPerQueue],
  );
  return rowCount ?? 0;
}

/**
 * Take the failed agent-tasks jobs we just inserted and mirror them into the
 * agent-tasks-dlq queue, the way pg-boss's own dead-letter routing would.
 */
async function mirrorDeadLetterJobs(pool: pg.Pool): Promise<number> {
  const { rowCount } = await pool.query(`
    INSERT INTO ${schema}.job
      (id, name, priority, data, state, retry_limit, retry_count,
       start_after, created_on, keep_until, source_name, source_id)
    SELECT
      gen_random_uuid(),
      'agent-tasks-dlq',
      priority,
      data,
      'created'::${schema}.job_state,
      0,
      0,
      completed_on,
      completed_on,
      completed_on + interval '30 days',
      'agent-tasks',
      id
    FROM ${schema}.job
    WHERE name = 'agent-tasks' AND state = 'failed'
  `);
  return rowCount ?? 0;
}

/** Same aggregation pg-boss's own monitor loop uses to cache counts on the queue row. */
async function refreshQueueCounts(pool: pg.Pool, name: string): Promise<void> {
  await pool.query(
    `
    WITH stats AS (
      SELECT
        (count(*) FILTER (WHERE start_after > now()))::int AS deferred_count,
        (count(*) FILTER (WHERE state < 'active'))::int AS queued_count,
        (count(*) FILTER (WHERE state = 'active'))::int AS active_count,
        (count(*) FILTER (WHERE state = 'failed'))::int AS failed_count,
        count(*)::int AS total_count
      FROM ${schema}.job
      WHERE name = $1
    )
    UPDATE ${schema}.queue SET
      deferred_count = stats.deferred_count,
      queued_count = stats.queued_count,
      ready_count = GREATEST(stats.queued_count - stats.deferred_count, 0),
      active_count = stats.active_count,
      failed_count = stats.failed_count,
      total_count = stats.total_count,
      monitor_on = now()
    FROM stats
    WHERE queue.name = $1
    `,
    [name],
  );
}

/** Synthetic history so /api/queues/:name/stats has data to plot without waiting for real traffic. */
async function seedQueueStatsHistory(pool: pg.Pool, name: string): Promise<number> {
  const { rowCount } = await pool.query(
    `
    INSERT INTO ${schema}.queue_stats
      (name, deferred_count, queued_count, ready_count, active_count, failed_count, total_count, captured_on)
    SELECT
      $1,
      (random() * 20)::int,
      (random() * 200)::int,
      (random() * 150)::int,
      (random() * 30)::int,
      (random() * 15)::int,
      (random() * 500)::int,
      now() - (m || ' minutes')::interval
    FROM generate_series(0, 360, 5) AS m
    WHERE now() - (m || ' minutes')::interval >= date_trunc('day', now())
    `,
    [name],
  );
  return rowCount ?? 0;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not defined in environment variables`);
  }
  return value;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
