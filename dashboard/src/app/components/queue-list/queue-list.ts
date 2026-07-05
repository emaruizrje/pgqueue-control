import { Component, inject } from '@angular/core';
import { DashboardStore } from '../../core/dashboard-store';
import { STATE_ORDER, type QueueSummary } from '../../core/models';
import { Sparkline } from '../sparkline/sparkline';

@Component({
  selector: 'app-queue-list',
  imports: [Sparkline],
  templateUrl: './queue-list.html',
})
export class QueueList {
  readonly store = inject(DashboardStore);
  readonly states = STATE_ORDER;

  total(q: QueueSummary): number {
    return this.states.reduce((n, s) => n + (q.counts[s] || 0), 0);
  }

  activeStates(q: QueueSummary): string[] {
    return this.states.filter((s) => (q.counts[s] || 0) > 0);
  }
}
