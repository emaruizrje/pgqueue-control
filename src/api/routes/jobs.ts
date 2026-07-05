/** Cross-queue job listing with state and date-range filters. */
import { Router } from 'express';
import { z } from 'zod';
import type { QueueAdapter } from '../../adapters/types.js';

const listJobsQuery = z
  .object({
    queue: z.string().optional(),
    state: z
      .enum(['created', 'retry', 'active', 'sleeping', 'completed', 'cancelled', 'failed'])
      .optional(),
    // uuid chars only: keeps LIKE wildcards (%/_) out of the prefix match
    id: z.string().trim().regex(/^[0-9a-fA-F-]{1,36}$/, 'id must be a uuid prefix').optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: 'from must be before to',
    path: ['from'],
  });

export function jobsRouter(adapter: QueueAdapter): Router {
  const router = Router();

  router.get('/api/jobs', async (req, res, next) => {
    try {
      const { from, to, ...filter } = listJobsQuery.parse(req.query);
      res.json(
        await adapter.listJobs({
          ...filter,
          createdAfter: from?.toISOString(),
          createdBefore: to?.toISOString(),
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  return router;
}
