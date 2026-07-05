/**
 * App factory: everything except listen(), so the same app runs as a local
 * server (server.ts) or a serverless function (api/index.ts on Vercel).
 *
 * Import specifiers use the .js extension (nodenext style): Vercel's
 * function bundler does not resolve explicit .ts specifiers.
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AbsurdAdapter } from '../adapters/absurd.js';
import { PgBossAdapter } from '../adapters/pgboss.js';
import type { QueueAdapter } from '../adapters/types.js';
import { ServerConfig } from '../helpers/configServer.js';
import { basicAuth } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { createRegistry } from './metrics.js';
import { healthRouter } from './routes/health.js';
import { jobsRouter } from './routes/jobs.js';
import { metricsRouter } from './routes/metrics.js';
import { queuesRouter } from './routes/queues.js';

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
