/**
 * Signal-based store: all dashboard state + the 4s polling loop.
 * Components read signals and call the mutation methods; every filter
 * mutation resets pagination and triggers an immediate refresh.
 */
import { Injectable, inject, signal } from '@angular/core';
import { ApiService, PAGE_SIZE } from './api.service';
import type { JobSummary, QueueStatPoint, QueueSummary } from './models';

const POLL_MS = 4000;

@Injectable({ providedIn: 'root' })
export class DashboardStore {
  private api = inject(ApiService);

  readonly queues = signal<QueueSummary[]>([]);
  readonly backend = signal('…');
  readonly jobs = signal<JobSummary[]>([]);
  readonly total = signal(0);
  readonly stats = signal<ReadonlyMap<string, QueueStatPoint[]>>(new Map());
  readonly error = signal<string | null>(null);
  readonly lastRefresh = signal<Date | null>(null);

  readonly filterQueue = signal('');
  readonly filterState = signal('');
  readonly filterId = signal('');
  readonly filterFrom = signal('');
  readonly filterTo = signal('');
  readonly offset = signal(0);

  /** null = closed; the drawer component loads the detail for this reference */
  readonly openJob = signal<{ queue: string; id: string } | null>(null);

  readonly pageSize = PAGE_SIZE;

  start(): void {
    void this.refresh();
    setInterval(() => void this.refresh(), POLL_MS);
  }

  async refresh(): Promise<void> {
    try {
      const [queuesRes, jobsRes] = await Promise.all([
        this.api.queues(),
        this.api.jobs({
          queue: this.filterQueue(),
          state: this.filterState(),
          id: this.filterId(),
          from: this.filterFrom(),
          to: this.filterTo(),
          offset: this.offset(),
        }),
      ]);
      this.queues.set(queuesRes.queues);
      this.backend.set(queuesRes.backend);
      this.jobs.set(jobsRes.jobs);
      this.total.set(jobsRes.total);
      this.lastRefresh.set(new Date());
      this.error.set(null);
      this.loadSparklines();
    } catch (err) {
      // HttpErrorResponse is not an Error instance; read its message explicitly
      const message =
        (err as { error?: { error?: string } })?.error?.error ??
        (err as { message?: string })?.message ??
        String(err);
      this.error.set(`Can't reach the API: ${message}. Retrying…`);
    }
  }

  private loadSparklines(): void {
    // fire-and-forget per queue, rendered when it lands
    for (const q of this.queues()) {
      this.api
        .stats(q.name)
        .then((r) => {
          const next = new Map(this.stats());
          next.set(q.name, r.points);
          this.stats.set(next);
        })
        .catch(() => {});
    }
  }

  toggleQueueFilter(name: string): void {
    this.filterQueue.set(this.filterQueue() === name ? '' : name);
    this.resetAndRefresh();
  }

  setFilter(patch: Partial<{ queue: string; state: string; id: string; from: string; to: string }>): void {
    if (patch.queue !== undefined) this.filterQueue.set(patch.queue);
    if (patch.state !== undefined) this.filterState.set(patch.state);
    if (patch.id !== undefined) this.filterId.set(patch.id);
    if (patch.from !== undefined) this.filterFrom.set(patch.from);
    if (patch.to !== undefined) this.filterTo.set(patch.to);
    this.resetAndRefresh();
  }

  prevPage(): void {
    this.offset.set(Math.max(0, this.offset() - PAGE_SIZE));
    void this.refresh();
  }

  nextPage(): void {
    this.offset.set(this.offset() + PAGE_SIZE);
    void this.refresh();
  }

  private resetAndRefresh(): void {
    this.offset.set(0);
    void this.refresh();
  }
}
