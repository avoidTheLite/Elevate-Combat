import { Router } from 'express';
import { json } from 'express';
import { gameController } from './gameController.ts';

export function gameRouter(): Router {
  const router = Router();
  const ctrl = gameController();

  router.use(json());

  router.post('/', ctrl.create);
  router.get('/:id', ctrl.getById);
  router.post('/:id/attack', ctrl.attack);
  router.post('/:id/end-turn', ctrl.endTurn);
  router.post('/:id/reset', ctrl.reset);

  return router;
}
