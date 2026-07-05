/**
 * Basic Auth middleware.
 *
 * Hardcoded credentials for now (no user database yet): defaults below,
 * overridable via PANEL_USER / PANEL_PASSWORD env vars.
 * /metrics stays open so Prometheus can scrape without credentials.
 */
import crypto from 'node:crypto';
import type express from 'express';

const PANEL_USER = process.env.PANEL_USER ?? 'admin';
const PANEL_PASSWORD = process.env.PANEL_PASSWORD ?? 'admin';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function basicAuth(): express.RequestHandler {
  return (req, res, next) => {
    if (req.path === '/metrics') return next();

    const header = req.headers.authorization ?? '';
    if (header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString();
      const sep = decoded.indexOf(':');
      if (
        sep > 0 &&
        safeEqual(decoded.slice(0, sep), PANEL_USER) &&
        safeEqual(decoded.slice(sep + 1), PANEL_PASSWORD)
      ) {
        return next();
      }
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="pgqueue-control"');
    res.status(401).json({ error: 'authentication required' });
  };
}
