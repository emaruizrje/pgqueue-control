/**
 * App factory: everything except listen(), so the same app runs as a local
 * server (server.ts) or a serverless function (api/index.ts on Vercel).
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AbsurdAdapter } from '../adapters/absurd.ts';
import { PgBossAdapter } from '../adapters/pgboss.ts';
import type { QueueAdapter } from '../adapters/types.ts';
import { ServerConfig } from '../helpers/configServer.ts';
import { basicAuth } from './middleware/auth.ts';
import { errorHandler } from './middleware/errorHandler.ts';
import { createRegistry } from './metrics.ts';
import { healthRouter } from './routes/health.ts';
import { jobsRouter } from './routes/jobs.ts';
import { metricsRouter } from './routes/metrics.ts';
import { queuesRouter } from './routes/queues.ts';

export function createAdapter(config: ServerConfig): QueueAdapter {
  switch (config.queueBackend) {
    case 'pgboss':
      return new PgBossAdapter({
        connectionString: config.databaseUrl,
        schema: process.env.PGBOSS_SCHEMA ?? 'pgboss',
      });
    case 'absurd':
      return new AbsurdAdapter({
        connectionString: config.databaseUrl,
        schema: process.env.ABSURD_SCHEMA ?? 'absurd',
      });
  }
}

export function createApp(): { app: express.Express; adapter: QueueAdapter; config: ServerConfig } {
  const config = new ServerConfig();
  const adapter = createAdapter(config);
  const registry = createRegistry(adapter);

  const app = express();
  app.use(express.json());
  app.use(basicAuth());

  // Dashboard: Angular production build, served from the same process.
  // On Vercel the static files are served by the CDN instead; if public/
  // is absent (serverless bundle) this quietly no-ops.
  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
  if (fs.existsSync(path.join(publicDir, 'index.html'))) {
    app.use(express.static(publicDir));
  }

  app.use(healthRouter(adapter));
  app.use(queuesRouter(adapter));
  app.use(jobsRouter(adapter));
  app.use(metricsRouter(registry));
  app.use(errorHandler());

  return { app, adapter, config };
}
