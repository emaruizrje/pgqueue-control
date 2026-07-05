/**
 * Adapter for Absurd (earendil-works/absurd, verified against schema v0.4):
 * durable workflows on plain Postgres — SQL functions + thin SDK, no extension.
 *
 * Schema notes (inspected live, not assumed):
 * - absurd.queues is the registry; each queue owns its own tables named
 *   t_<queue> (tasks), r_<queue> (run attempts), c_<queue> (checkpoints),
 *   e_<queue> (events), w_<queue> (waits). Names can contain dashes, so all
 *   are interpolated as quoted identifiers after validating the queue exists.
 * - Task state is text with CHECK constraint:
 *   pending | running | sleeping | completed | failed | cancelled.
 * - There is no distinct retry state. `attempts` increments when a run is
 *   spawned (a never-executed task already has attempts = 1), so the reliable
 *   discriminator is first_started_at: pending + never started = created,
 *   pending + started before = retry.
 * - retryJob delegates to absurd.retry_task(), which raises unless the task
 *   is currently 'failed' — we catch and report false, same 409 semantics as
 *   the pg-boss adapter.
 * - Absurd keeps no depth-history table, so queueStats() returns [].
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

export interface AbsurdAdapterOptions {
  connectionString: string;
  schema?: string; // absurd default: "absurd"
}

/** state mapping applied in SQL: absurd task -> shared JobState */
const STATE_CASE = `
  CASE
    WHEN t.state = 'pending' AND t.first_started_at IS NOT NULL THEN 'retry'
    WHEN t.state = 'pending' THEN 'created'
    WHEN t.state = 'running' THEN 'active'
    ELSE t.state
  END
`;

/** inverse mapping: shared JobState filter -> SQL condition on the task row */
const STATE_FILTERS: Record<JobState, string> = {
  created: `(t.state = 'pending' AND t.first_started_at IS NULL)`,
  retry: `(t.state = 'pending' AND t.first_started_at IS NOT NULL)`,
  active: `t.state = 'running'`,
  sleeping: `t.state = 'sleeping'`,
  completed: `t.state = 'completed'`,
  cancelled: `t.state = 'cancelled'`,
  failed: `t.state = 'failed'`,
};

export class AbsurdAdapter implements QueueAdapter {
  readonly backend = 'absurd';
  private pool: pg.Pool;
  private schema: string;

  constructor(opts: AbsurdAdapterOptions) {
    this.pool = new pg.Pool({
      connectionString: opts.connectionString,
      max: 5,
      application_name: 'pgqueue-control',
    });
    this.pool.on('error', (err) => {
      console.error('pg pool error', err);
    });
    this.schema = validateIdentifier(opts.schema ?? 'absurd');
  }

  /** Queue names drive dynamic table names; only ever use names the registry knows. */
  private async knownQueues(): Promise<string[]> {
    const { rows } = await this.pool.query(
      `SELECT queue_name FROM ${this.schema}.queues ORDER BY queue_name`,
    );
    return rows.map((r) => r.queue_name as string);
  }

  private async assertQueue(name: string): Promise<void> {
    const { rowCount } = await this.pool.query(
      `SELECT 1 FROM ${this.schema}.queues WHERE queue_name = $1`,
      [name],
    );
    if (!rowCount) throw new QueueNotFoundError(name);
  }

  private taskTable(queue: string): string {
    return `${this.schema}.${quoteIdent('t_' + queue)}`;
  }

  async listQueues(): Promise<QueueSummary[]> {
    const queues = await this.knownQueues();
    const summaries: QueueSummary[] = [];
    for (const name of queues) {
      const { rows } = await this.pool.query(`
        SELECT ${STATE_CASE} AS state, count(*) AS n
        FROM ${this.taskTable(name)} t
        GROUP BY 1
      `);
      const counts: Record<string, number> = {
        created: 0, retry: 0, active: 0, sleeping: 0,
        completed: 0, cancelled: 0, failed: 0,
      };
      for (const r of rows) counts[r.state] = Number(r.n);
      summaries.push({
        name,
        isDeadLetter: false, // Absurd has no dead-letter routing; failures stay on the task
        deadLetterTarget: null,
        retryLimit: null, // max_attempts is per-task in Absurd, not per-queue
        policy: null,
        counts: {
          created: counts['created'] ?? 0,
          retry: counts['retry'] ?? 0,
          active: counts['active'] ?? 0,
          sleeping: counts['sleeping'] ?? 0,
          completed: counts['completed'] ?? 0,
          cancelled: counts['cancelled'] ?? 0,
          failed: counts['failed'] ?? 0,
          queued: (counts['created'] ?? 0) + (counts['retry'] ?? 0),
          deferred: counts['sleeping'] ?? 0,
        },
      });
    }
    return summaries;
  }

  async listJobs(filter: JobFilter): Promise<{ jobs: JobSummary[]; total: number }> {
    const queues = filter.queue ? [filter.queue] : await this.knownQueues();
    if (filter.queue) await this.assertQueue(filter.queue);
    if (queues.length === 0) return { jobs: [], total: 0 };

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.state) conditions.push(STATE_FILTERS[filter.state]);
    if (filter.id) {
      params.push(filter.id.toLowerCase());
      conditions.push(`t.task_id::text LIKE $${params.length} || '%'`);
    }
    if (filter.createdAfter) {
      params.push(filter.createdAfter);
      conditions.push(`t.enqueue_at >= $${params.length}::timestamptz`);
    }
    if (filter.createdBefore) {
      params.push(filter.createdBefore);
      conditions.push(`t.enqueue_at <= $${params.length}::timestamptz`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // Same placeholders are reused by every UNION branch — it is one statement.
    const union = queues
      .map(
        (q) => `
        SELECT t.task_id, ${sqlLiteral(q)} AS queue, t.task_name, ${STATE_CASE} AS state,
               t.attempts, t.max_attempts, t.enqueue_at, t.first_started_at, t.cancelled_at,
               r.completed_at, r.failed_at, r.available_at
        FROM ${this.taskTable(q)} t
        LEFT JOIN ${this.schema}.${quoteIdent('r_' + q)} r ON r.run_id = t.last_attempt_run
        ${where}`,
      )
      .join('\nUNION ALL\n');

    const limitParam = params.length + 1;
    const offsetParam = params.length + 2;
    const [countRes, rowsRes] = await Promise.all([
      this.pool.query(`SELECT count(*)::int AS total FROM (${union}) all_tasks`, params),
      this.pool.query(
        `SELECT * FROM (${union}) all_tasks ORDER BY enqueue_at DESC LIMIT $${limitParam} OFFSET $${offsetParam}`,
        [...params, filter.limit, filter.offset],
      ),
    ]);
    return {
      total: countRes.rows[0].total,
      jobs: rowsRes.rows.map(mapTaskRow),
    };
  }

  async getJob(queue: string, id: string): Promise<JobDetail | null> {
    await this.assertQueue(queue);
    const { rows } = await this.pool.query(
      `
      SELECT t.task_id, ${sqlLiteral(queue)} AS queue, t.task_name, ${STATE_CASE} AS state,
             t.attempts, t.max_attempts, t.enqueue_at, t.first_started_at, t.cancelled_at,
             t.params, t.completed_payload,
             r.completed_at, r.failed_at, r.available_at, r.failure_reason,
             q.cleanup_ttl
      FROM ${this.taskTable(queue)} t
      LEFT JOIN ${this.schema}.${quoteIdent('r_' + queue)} r ON r.run_id = t.last_attempt_run
      CROSS JOIN (SELECT cleanup_ttl FROM ${this.schema}.queues WHERE queue_name = $2) q
      WHERE t.task_id = $1
      `,
      [id, queue],
    );
    const r = rows[0];
    if (!r) return null;

    const { rows: checkpoints } = await this.pool.query(
      `
      SELECT checkpoint_name, status, state, updated_at
      FROM ${this.schema}.${quoteIdent('c_' + queue)}
      WHERE task_id = $1
      ORDER BY updated_at
      `,
      [id],
    );

    const terminalOn = r.completed_at ?? r.failed_at ?? r.cancelled_at;
    return {
      ...mapTaskRow(r),
      data: r.params,
      output: r.completed_payload ?? r.failure_reason,
      keepUntil: terminalOn
        ? new Date(new Date(terminalOn).getTime() + intervalMs(r.cleanup_ttl)).toISOString()
        : new Date(Date.now() + intervalMs(r.cleanup_ttl)).toISOString(),
      deadLetter: null,
      checkpoints: checkpoints.map((c) => ({
        name: c.checkpoint_name,
        status: c.status,
        state: c.state,
        updatedAt: iso(c.updated_at)!,
      })),
    };
  }

  /** Absurd keeps no depth history (pg-boss's queue_stats has no equivalent). */
  async queueStats(_queue: string, _sinceMinutes: number): Promise<QueueStatPoint[]> {
    return [];
  }

  async retryJob(queue: string, id: string): Promise<boolean> {
    await this.assertQueue(queue);
    try {
      await this.pool.query(`SELECT ${this.schema}.retry_task($1, $2::uuid)`, [queue, id]);
      return true;
    } catch (err) {
      // retry_task raises for unknown tasks and for any non-'failed' state
      if (err instanceof Error && /not found|not currently failed/.test(err.message)) {
        return false;
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export class QueueNotFoundError extends Error {
  constructor(queue: string) {
    super(`queue not found: ${queue}`);
  }
}

function mapTaskRow(r: Record<string, unknown>): JobSummary {
  return {
    id: String(r.task_id),
    queue: String(r.queue),
    state: r.state as JobState,
    priority: 0, // Absurd has no task priority
    retryCount: Math.max(Number(r.attempts) - 1, 0),
    retryLimit: r.max_attempts === null ? 1 : Number(r.max_attempts),
    createdOn: iso(r.enqueue_at)!,
    startedOn: iso(r.first_started_at),
    completedOn: iso(r.completed_at ?? r.failed_at ?? r.cancelled_at),
    startAfter: iso(r.available_at) ?? iso(r.enqueue_at)!,
    sourceQueue: null,
    sourceJobId: null,
  };
}

function iso(v: unknown): string | null {
  return v ? new Date(v as string).toISOString() : null;
}

/** postgres interval (as reported by pg driver, e.g. "30 days") -> milliseconds */
function intervalMs(v: unknown): number {
  const m = /^(\d+) days?/.exec(String(v ?? ''));
  return m ? Number(m[1]) * 86_400_000 : 30 * 86_400_000;
}

function validateIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`Invalid schema identifier: ${name}`);
  }
  return name;
}

/**
 * Quote a dynamic identifier (queue-derived table names may contain dashes).
 * Only used for names verified against absurd.queues first.
 */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Quote a text literal for interpolation inside a UNION branch. */
function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
