/**
 * Vercel serverless entry: every /api/* and /metrics request is rewritten
 * here (see vercel.json) and handled by the same Express app the local
 * server uses. Static assets are served by Vercel's CDN, not this function.
 */
import { createApp } from '../src/api/app.ts';

const { app } = createApp();

export default app;
