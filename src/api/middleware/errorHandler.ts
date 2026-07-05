/** Zod validation errors -> 400, unknown queue -> 404, everything else -> 500 */
import type express from 'express';
import { z } from 'zod';
import { QueueNotFoundError } from '../../adapters/absurd.js';

export function errorHandler(): express.ErrorRequestHandler {
  return (err: unknown, _req, res, _next) => {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'invalid query', issues: err.issues });
    }
    if (err instanceof QueueNotFoundError) {
      return res.status(404).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  };
}
