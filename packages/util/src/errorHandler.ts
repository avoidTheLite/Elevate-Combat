import type { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import { AppError } from '@iron-ridge/types';
import { createLogger } from './logger.ts';

const log = createLogger('error-handler');

export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  if (err instanceof AppError) {
    log.warn({ code: err.code, status: err.statusCode }, err.message);
    res.status(err.statusCode).json({ error: { code: err.code, message: err.message } });
    return;
  }

  const message = err instanceof Error ? err.message : 'Internal server error';
  log.error({ err }, message);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message } });
};
