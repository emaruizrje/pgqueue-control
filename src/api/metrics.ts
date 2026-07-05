/** Prometheus registry: default process metrics + per-queue job gauge. */
import { Registry, Gauge, collectDefaultMetrics } from 'prom-client';
import type { QueueAdapter } from '../adapters/types.ts';

export function createRegistry(adapter: QueueAdapter): Registry {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  new Gauge({
    name: 'pgqueue_jobs',
    help: 'Number of jobs by queue and state',
    labelNames: ['backend', 'queue', 'state'] as const,
    registers: [registry],
    async collect() {
      const queues = await adapter.listQueues();
      this.reset();
      for (const q of queues) {
        for (const [state, n] of Object.entries(q.counts)) {
          this.set({ backend: adapter.backend, queue: q.name, state }, n);
        }
      }
    },
  });

  return registry;
}
