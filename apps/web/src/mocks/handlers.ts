import { http, HttpResponse } from 'msw';
import type { CreateGameResponse, GetGameResponse, AttackResponse, EndTurnResponse, ResetGameResponse } from '@iron-ridge/types';

const mockGame: GetGameResponse['game'] = {
  id: 'test-game-id',
  era: 'ww2',
  phase: 'combat',
  turn: 1,
  activeTeam: 'A',
  units: [
    {
      id: 'A_ww2_tank_0',
      defId: 'ww2_tank',
      team: 'A',
      col: 2,
      row: 4,
      label: 'TK-1',
      hp: 30,
      maxHp: 30,
      moved: false,
      fired: false,
    },
    {
      id: 'B_ww2_tank_0',
      defId: 'ww2_tank',
      team: 'B',
      col: 17,
      row: 4,
      label: 'TK-1',
      hp: 30,
      maxHp: 30,
      moved: false,
      fired: false,
    },
  ],
  combatLog: [],
  map: {
    id: 'map_01',
    name: 'Map-01 "The Defile"',
    cols: 20,
    rows: 12,
    hm: Array.from({ length: 12 }, () => Array.from({ length: 20 }, () => 3) as number[]),
  },
};

export const handlers = [
  http.post('/game', () => {
    const response: CreateGameResponse = { game: mockGame };
    return HttpResponse.json(response, { status: 201 });
  }),

  http.get('/game/:id', ({ params }) => {
    const response: GetGameResponse = { game: { ...mockGame, id: params['id'] as string } };
    return HttpResponse.json(response);
  }),

  http.post('/game/:id/attack', ({ params }) => {
    const response: AttackResponse = {
      result: {
        attackerId: 'A_ww2_tank_0',
        defenderId: 'B_ww2_tank_0',
        toHitRoll: 15,
        adjustedTN: 10,
        hit: true,
        splash: false,
        damageRoll: 8,
        armorReduction: 6,
        finalDamage: 2,
        log: ['DIRECT HIT', 'After armor (6): 2 damage'],
      },
      game: { ...mockGame, id: params['id'] as string },
    };
    return HttpResponse.json(response);
  }),

  http.post('/game/:id/end-turn', ({ params }) => {
    const response: EndTurnResponse = {
      game: { ...mockGame, id: params['id'] as string, activeTeam: 'B' },
    };
    return HttpResponse.json(response);
  }),

  http.post('/game/:id/reset', ({ params }) => {
    const response: ResetGameResponse = { game: { ...mockGame, id: params['id'] as string } };
    return HttpResponse.json(response);
  }),
];
