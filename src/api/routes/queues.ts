/** Queue listing, per-queue stats, job detail and retry. */
import { Router } from 'express';
import { z } from 'zod';
import type { QueueAdapter } from '../../adapters/types.js';

const sinceMinutesSchema = z.coerce.number().int().min(1).max(60 * 24 * 7).default(60);

export function queuesRouter(adapter: QueueAdapter): Router {
  const router = Router();

  router.get('/api/queues', async (_req, res, next) => {
    try {
      res.json({ backend: adapter.backend, queues: await adapter.listQueues() });
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/queues/:name/stats', async (req, res, next) => {
    try {
      const since = sinceMinutesSchema.parse(req.query.sinceMinutes ?? 60);
      res.json({ points: await adapter.queueStats(req.params.name, since) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/queues/:name/jobs/:id', async (req, res, next) => {
    try {
      const job = await adapter.getJob(req.params.name, req.params.id);
      if (!job) return res.status(404).json({ error: 'job not found' });
      res.json(job);
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/queues/:name/jobs/:id/retry', async (req, res, next) => {
    try {
      const ok = await adapter.retryJob(req.params.name, req.params.id);
      if (!ok) {
        return res
          .status(409)
          .json({ error: 'job not found or not in a retryable state (failed/cancelled)' });
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
