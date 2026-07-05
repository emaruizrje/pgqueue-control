/**
 * Adapter for pg-boss (v10+ schema, verified against v12).
 *
 * Design notes — this is where the "we respect your database" pitch lives:
 * - Read-only queries against pgboss.* tables, except retryJob.
 * - pgboss.queue keeps live counters (ready/active/failed/total), so the
 *   queue list view costs a single indexed scan of a tiny table — we never
 *   aggregate the (potentially huge, partitioned) job table for the overview.
 * - Job listings hit pgboss.job partitions by queue name, which is the
 *   partition key — Postgres prunes to a single partition.
 * - No long transactions, no locks taken on job rows.
 */
import pg from 'pg';
import type {
  JobDetail,
  JobFilter,
  JobState,
  JobSummary,
  QueueAdapter,
  QueueStatPoint,
  QueueSummary,
} from './types.js';

export interface PgBossAdapterOptions {
  connectionString: string;
  schema?: string; // pg-boss default: "pgboss"
}

export class PgBossAdapter implements QueueAdapter {
  readonly backend = 'pg-boss';
  private pool: pg.Pool;
  private schema: string;

  constructor(opts: PgBossAdapterOptions) {
    this.pool = new pg.Pool({
      connectionString: opts.connectionString,
      max: 5,
      application_name: 'pgqueue-control',
    });
    // Identifier is interpolated into SQL: validate strictly.
    this.schema = validateIdentifier(opts.schema ?? 'pgboss');
  }

  async listQueues(): Promise<QueueSummary[]> {
    const { rows } = await this.pool.query(`
      SELECT q.name,
             q.policy,
             q.retry_limit,
             q.dead_letter,
             q.deferred_count,
             q.queued_count,
             q.ready_count,
             q.active_count,
             q.failed_count,
             q.total_count,
             EXISTS (
               SELECT 1 FROM ${this.schema}.queue q2 WHERE q2.dead_letter = q.name
             ) AS is_dead_letter,
             s.counts AS state_counts
      FROM ${this.schema}.queue q
      LEFT JOIN LATERAL (
        SELECT jsonb_object_agg(j.state, j.n) AS counts
        FROM (
          SELECT state, count(*) AS n
          FROM ${this.schema}.job
          WHERE name = q.name
          GROUP BY state
        ) j
      ) s ON true
      ORDER BY q.name
    `);

    return rows.map((r) => {
      const stateCounts = (r.state_counts ?? {}) as Record<string, number>;
      return {
        name: r.name,
        isDeadLetter: r.is_dead_letter,
        deadLetterTarget: r.dead_letter,
        retryLimit: r.retry_limit,
        policy: r.policy,
        counts: {
          created: Number(stateCounts['created'] ?? 0),
          retry: Number(stateCounts['retry'] ?? 0),
          active: Number(stateCounts['active'] ?? 0),
          sleeping: 0, // pg-boss has no suspended-workflow state

          completed: Number(stateCounts['completed'] ?? 0),
          cancelled: Number(stateCounts['cancelled'] ?? 0),
          failed: Number(stateCounts['failed'] ?? 0),
          queued: Number(r.queued_count ?? 0),
          deferred: Number(r.deferred_count ?? 0),
        },
      };
    });
  }

  async listJobs(filter: JobFilter): Promise<{ jobs: JobSummary[]; total: number }> {
    // 'sleeping' is not a pg-boss state; casting it to the enum would throw.
    if (filter.state === 'sleeping') return { jobs: [], total: 0 };

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.queue) {
      params.push(filter.queue);
      conditions.push(`name = $${params.length}`);
    }
    if (filter.state) {
      params.push(filter.state);
      conditions.push(`state = $${params.length}::${this.schema}.job_state`);
    }
    if (filter.id) {
      params.push(filter.id.toLowerCase());
      conditions.push(`id::text LIKE $${params.length} || '%'`);
    }
    if (filter.createdAfter) {
      params.push(filter.createdAfter);
      conditions.push(`created_on >= $${params.length}::timestamptz`);
    }
    if (filter.createdBefore) {
      params.push(filter.createdBefore);
      conditions.push(`created_on <= $${params.length}::timestamptz`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countPromise = this.pool.query(
      `SELECT count(*)::int AS total FROM ${this.schema}.job ${where}`,
      params,
    );

    const limitParam = params.length + 1;
    const offsetParam = params.length + 2;
    const rowsPromise = this.pool.query(
      `
      SELECT id, name, state, priority, retry_count, retry_limit,
             created_on, started_on, completed_on, start_after,
             source_name, source_id
      FROM ${this.schema}.job
      ${where}
      ORDER BY created_on DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}
      `,
      [...params, filter.limit, filter.offset],
    );

    const [countRes, rowsRes] = await Promise.all([countPromise, rowsPromise]);
    return {
      total: countRes.rows[0].total,
      jobs: rowsRes.rows.map(mapJobRow),
    };
  }

  async getJob(queue: string, id: string): Promise<JobDetail | null> {
    const { rows } = await this.pool.query(
      `
      SELECT id, name, state, priority, retry_count, retry_limit,
             created_on, started_on, completed_on, start_after, keep_until,
             data, output, dead_letter, source_name, source_id
      FROM ${this.schema}.job
      WHERE name = $1 AND id = $2
      `,
      [queue, id],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      ...mapJobRow(r),
      data: r.data,
      output: r.output,
      keepUntil: iso(r.keep_until)!,
      deadLetter: r.dead_letter,
    };
  }

  async queueStats(queue: string, sinceMinutes: number): Promise<QueueStatPoint[]> {
    const { rows } = await this.pool.query(
      `
      SELECT captured_on, deferred_count, queued_count, ready_count,
             active_count, failed_count, total_count
      FROM ${this.schema}.queue_stats
      WHERE name = $1 AND captured_on > now() - ($2 || ' minutes')::interval
      ORDER BY captured_on
      `,
      [queue, String(sinceMinutes)],
    );
    return rows.map((r) => ({
      capturedOn: iso(r.captured_on)!,
      deferred: r.deferred_count,
      queued: r.queued_count,
      ready: r.ready_count,
      active: r.active_count,
      failed: r.failed_count,
      total: r.total_count,
    }));
  }

  async retryJob(queue: string, id: string): Promise<boolean> {
    // Same semantics as boss.retry(): flip failed/cancelled back to retry state.
    const { rowCount } = await this.pool.query(
      `
      UPDATE ${this.schema}.job
      SET state = 'retry'::${this.schema}.job_state,
          start_after = now(),
          completed_on = NULL
      WHERE name = $1 AND id = $2
        AND state IN ('failed'::${this.schema}.job_state, 'cancelled'::${this.schema}.job_state)
      `,
      [queue, id],
    );
    return (rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function mapJobRow(r: Record<string, unknown>): JobSummary {
  return {
    id: String(r.id),
    queue: String(r.name),
    state: r.state as JobState,
    priority: Number(r.priority),
    retryCount: Number(r.retry_count),
    retryLimit: Number(r.retry_limit),
    createdOn: iso(r.created_on)!,
    startedOn: iso(r.started_on),
    completedOn: iso(r.completed_on),
    startAfter: iso(r.start_after)!,
    sourceQueue: (r.source_name as string) ?? null,
    sourceJobId: r.source_id ? String(r.source_id) : null,
  };
}

function iso(v: unknown): string | null {
  return v ? new Date(v as string).toISOString() : null;
}

function validateIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`Invalid schema identifier: ${name}`);
  }
  return name;
}
