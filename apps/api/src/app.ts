import express from 'express';
import cors from 'cors';
import { errorHandler } from '@iron-ridge/util';
import { gameRouter } from './game/gameRouter.ts';

export function createApp(): express.Express {
  const app = express();

  app.use(cors());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/game', gameRouter());

  app.use(errorHandler);

  return app;
}
