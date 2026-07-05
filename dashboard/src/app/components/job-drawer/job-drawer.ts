/**
 * Job detail drawer. Loads the detail whenever store.openJob changes; the
 * body-level `drawer-open` class drives the same slide-in CSS as before.
 */
import { Component, effect, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api.service';
import { DashboardStore } from '../../core/dashboard-store';
import type { JobDetail } from '../../core/models';

@Component({
  selector: 'app-job-drawer',
  templateUrl: './job-drawer.html',
})
export class JobDrawer {
  readonly store = inject(DashboardStore);
  private api = inject(ApiService);

  readonly job = signal<JobDetail | null>(null);
  readonly loadError = signal<string | null>(null);
  readonly retryResult = signal<{ ok: boolean; message: string } | null>(null);
  readonly retrying = signal(false);

  constructor() {
    effect(() => {
      const ref = this.store.openJob();
      document.body.classList.toggle('drawer-open', ref !== null);
      if (ref) void this.load(ref.queue, ref.id);
    });
  }

  private async load(queue: string, id: string): Promise<void> {
    this.job.set(null);
    this.loadError.set(null);
    this.retryResult.set(null);
    this.retrying.set(false);
    try {
      this.job.set(await this.api.job(queue, id));
    } catch (err) {
      this.loadError.set(err instanceof Error ? err.message : String(err));
    }
  }

  close(): void {
    this.store.openJob.set(null);
  }

  retryable(): boolean {
    const j = this.job();
    return j?.state === 'failed' || j?.state === 'cancelled';
  }

  async retry(): Promise<void> {
    const ref = this.store.openJob();
    if (!ref) return;
    this.retrying.set(true);
    try {
      await this.api.retry(ref.queue, ref.id);
      this.retryResult.set({ ok: true, message: 'Re-enqueued' });
      void this.store.refresh();
    } catch (err) {
      this.retryResult.set({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
      this.retrying.set(false);
    }
  }

  openSource(): void {
    const j = this.job();
    if (j?.sourceQueue && j.sourceJobId) {
      this.store.openJob.set({ queue: j.sourceQueue, id: j.sourceJobId });
    }
  }

  json(v: unknown): string {
    return JSON.stringify(v, null, 2) ?? 'null';
  }
}
