import { Router } from 'express';
import type { Registry } from 'prom-client';

export function metricsRouter(registry: Registry): Router {
  const router = Router();

  router.get('/metrics', async (_req, res, next) => {
    try {
      res.setHeader('Content-Type', registry.contentType);
      res.send(await registry.metrics());
    } catch (err) {
      next(err);
    }
  });

  return router;
}
