/**
 * Backend-agnostic contract. Each queue system (pg-boss, Absurd, graphile-worker…)
 * implements this interface by reading its own schema.
 */

export type JobState =
  | 'created'
  | 'retry'
  | 'active'
  | 'sleeping' // durable-workflow backends only: suspended waiting on a timer/event
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface QueueSummary {
  name: string;
  /** Counts by state, straight from the backend */
  counts: Record<JobState | 'queued' | 'deferred', number>;
  isDeadLetter: boolean;
  deadLetterTarget: string | null;
  retryLimit: number | null;
  policy: string | null;
}

export interface JobSummary {
  id: string;
  queue: string;
  state: JobState;
  priority: number;
  retryCount: number;
  retryLimit: number;
  createdOn: string;
  startedOn: string | null;
  completedOn: string | null;
  startAfter: string;
  /** For dead-lettered jobs: where the job originally failed */
  sourceQueue: string | null;
  sourceJobId: string | null;
}

export interface JobDetail extends JobSummary {
  data: unknown;
  /** Error info / handler return value */
  output: unknown;
  keepUntil: string;
  deadLetter: string | null;
  /** Durable-workflow backends: persisted step results (checkpoint = resume point) */
  checkpoints?: JobCheckpoint[];
}

export interface JobCheckpoint {
  name: string;
  status: string;
  state: unknown;
  updatedAt: string;
}

export interface JobFilter {
  queue?: string | undefined;
  state?: JobState | undefined;
  /** Job id prefix (the UI shows truncated ids, so prefix match) */
  id?: string | undefined;
  /** ISO datetime: only jobs created at/after this instant */
  createdAfter?: string | undefined;
  /** ISO datetime: only jobs created at/before this instant */
  createdBefore?: string | undefined;
  limit: number;
  offset: number;
}

export interface QueueStatPoint {
  capturedOn: string;
  queued: number;
  ready: number;
  active: number;
  failed: number;
  deferred: number;
  total: number;
}

export interface QueueAdapter {
  readonly backend: string;
  listQueues(): Promise<QueueSummary[]>;
  listJobs(filter: JobFilter): Promise<{ jobs: JobSummary[]; total: number }>;
  getJob(queue: string, id: string): Promise<JobDetail | null>;
  /** Historical depth samples for sparklines / dashboards */
  queueStats(queue: string, sinceMinutes: number): Promise<QueueStatPoint[]>;
  /** Re-enqueue a failed job */
  retryJob(queue: string, id: string): Promise<boolean>;
  close(): Promise<void>;
}
