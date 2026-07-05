/** Mirrors the API contract (src/adapters/types.ts on the server side). */

export type JobState =
  | 'created'
  | 'retry'
  | 'active'
  | 'sleeping'
  | 'completed'
  | 'cancelled'
  | 'failed';

export const STATE_ORDER: JobState[] = [
  'active', 'retry', 'created', 'sleeping', 'failed', 'cancelled', 'completed',
];

export interface QueueSummary {
  name: string;
  counts: Record<string, number>;
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
  sourceQueue: string | null;
  sourceJobId: string | null;
}

export interface JobCheckpoint {
  name: string;
  status: string;
  state: unknown;
  updatedAt: string;
}

export interface JobDetail extends JobSummary {
  data: unknown;
  output: unknown;
  keepUntil: string;
  deadLetter: string | null;
  checkpoints?: JobCheckpoint[];
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

export interface QueuesResponse {
  backend: string;
  queues: QueueSummary[];
}

export interface JobsResponse {
  jobs: JobSummary[];
  total: number;
}

export interface JobFilters {
  queue: string;
  state: string;
  id: string;
  from: string; // datetime-local value, local time
  to: string;
  offset: number;
}
