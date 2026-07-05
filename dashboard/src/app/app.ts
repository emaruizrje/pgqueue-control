import { Component, HostListener, inject } from '@angular/core';
import { JobDrawer } from './components/job-drawer/job-drawer';
import { JobsTable } from './components/jobs-table/jobs-table';
import { QueueList } from './components/queue-list/queue-list';
import { DashboardStore } from './core/dashboard-store';

@Component({
  selector: 'app-root',
  imports: [QueueList, JobsTable, JobDrawer],
  templateUrl: './app.html',
})
export class App {
  readonly store = inject(DashboardStore);

  constructor() {
    this.store.start();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.store.openJob.set(null);
  }

  refreshLabel(): string {
    const t = this.store.lastRefresh();
    return t ? `updated ${t.toLocaleTimeString()}` : 'connecting…';
  }
}
