import type { Request, Response } from 'express';
import type { AttackBody, CreateGameBody } from '@iron-ridge/types';
import { NotFoundError, ValidationError } from '@iron-ridge/types';
import * as gs from './gameState.ts';

export function gameController(): {
  create: (req: Request, res: Response) => void;
  getById: (req: Request, res: Response) => void;
  attack: (req: Request, res: Response) => void;
  endTurn: (req: Request, res: Response) => void;
  reset: (req: Request, res: Response) => void;
} {
  return {
    create(req: Request, res: Response): void {
      const body = req.body as CreateGameBody;
      const game = gs.createGame(body.era ?? 'ww2');
      res.status(201).json({ game });
    },

    getById(req: Request, res: Response): void {
      const { id } = req.params as { id: string };
      const game = gs.getGame(id);
      if (!game) throw new NotFoundError(`Game ${id}`);
      res.json({ game });
    },

    attack(req: Request, res: Response): void {
      const { id } = req.params as { id: string };
      const body = req.body as AttackBody;

      if (!body.attackerId || !body.defenderId) {
        throw new ValidationError('attackerId and defenderId are required');
      }

      const outcome = gs.attack(id, body.attackerId, body.defenderId, {
        attackerMoved: body.attackerMoved,
        facingMod: body.facingMod,
        facingDmg: body.facingDmg,
        blindFire: body.blindFire,
      });

      if (!outcome) throw new NotFoundError(`Game ${id}`);
      res.json({ result: outcome.result, game: outcome.game });
    },

    endTurn(req: Request, res: Response): void {
      const { id } = req.params as { id: string };
      const game = gs.endTurn(id);
      if (!game) throw new NotFoundError(`Game ${id}`);
      res.json({ game });
    },

    reset(req: Request, res: Response): void {
      const { id } = req.params as { id: string };
      const game = gs.resetGame(id);
      if (!game) throw new NotFoundError(`Game ${id}`);
      res.json({ game });
    },
  };
}
