import { Component, inject } from '@angular/core';
import { DashboardStore } from '../../core/dashboard-store';
import type { JobSummary } from '../../core/models';

@Component({
  selector: 'app-jobs-table',
  templateUrl: './jobs-table.html',
})
export class JobsTable {
  readonly store = inject(DashboardStore);
  readonly states = ['created', 'retry', 'active', 'sleeping', 'completed', 'cancelled', 'failed'];

  private idDebounce: ReturnType<typeof setTimeout> | undefined;

  page(): number {
    return Math.floor(this.store.offset() / this.store.pageSize) + 1;
  }

  pages(): number {
    return Math.max(1, Math.ceil(this.store.total() / this.store.pageSize));
  }

  hasDateFilter(): boolean {
    return !!(this.store.filterFrom() || this.store.filterTo());
  }

  onIdInput(value: string): void {
    clearTimeout(this.idDebounce);
    this.idDebounce = setTimeout(() => {
      // uuid chars only — anything else would 400 on the API
      this.store.setFilter({ id: value.trim().replace(/[^0-9a-fA-F-]/g, '') });
    }, 250);
  }

  clearDates(fromEl: HTMLInputElement, toEl: HTMLInputElement): void {
    fromEl.value = '';
    toEl.value = '';
    this.store.setFilter({ from: '', to: '' });
  }

  duration(j: JobSummary): string {
    if (j.startedOn && j.completedOn) {
      return `${((+new Date(j.completedOn) - +new Date(j.startedOn)) / 1000).toFixed(1)}s`;
    }
    return j.startedOn ? 'running' : '—';
  }

  time(iso: string): string {
    return new Date(iso).toLocaleTimeString();
  }
}
