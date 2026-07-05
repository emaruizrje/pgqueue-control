/**
 * pgqueue-control API — local/container entry point.
 * The app itself is assembled in app.ts (also used by the Vercel function).
 */
import { createApp } from './app.ts';

const { app, adapter, config } = createApp();

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
