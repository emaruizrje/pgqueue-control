import { Router } from 'express';
import type { QueueAdapter } from '../../adapters/types.ts';

export function healthRouter(adapter: QueueAdapter): Router {
  const router = Router();

  router.get('/api/health', (_req, res) => {
    res.json({ ok: true, backend: adapter.backend });
  });

  return router;
}
