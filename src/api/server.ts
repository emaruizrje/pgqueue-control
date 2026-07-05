/**
 * pgqueue-control API — bootstrap only.
 *
 * Endpoints live in ./routes, cross-cutting concerns in ./middleware.
 * Read-mostly HTTP layer over a QueueAdapter, plus a Prometheus /metrics
 * endpoint so you can alert on queue depth / failure counts from day one.
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

const config = new ServerConfig();

function createAdapter(): QueueAdapter {
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

const adapter: QueueAdapter = createAdapter();
const registry = createRegistry(adapter);

const app = express();
app.use(express.json());
app.use(basicAuth());

// Dashboard: static, no build step — served from the same process.
// fileURLToPath (not URL.pathname) so the path also works on Windows.
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
if (!fs.existsSync(path.join(publicDir, 'index.html'))) {
  console.warn(`[warn] dashboard not found at ${publicDir} — API will work but / will 404`);
}
app.use(express.static(publicDir));

app.use(healthRouter(adapter));
app.use(queuesRouter(adapter));
app.use(jobsRouter(adapter));
app.use(metricsRouter(registry));
app.use(errorHandler());

const server = app.listen(config.port, () => {
  console.log(`pgqueue-control API (${adapter.backend}) on http://localhost:${config.port}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    server.close();
    await adapter.close();
    process.exit(0);
  });
}
