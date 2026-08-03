import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  GetGameResponse,
  CreateGameResponse,
  AttackResponse,
  EndTurnResponse,
  ResetGameResponse,
  AttackBody,
} from '@iron-ridge/types';

const BASE = '/game';

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export function useGameQuery(gameId: string | null): ReturnType<typeof useQuery<GetGameResponse>> {
  return useQuery<GetGameResponse>({
    queryKey: ['game', gameId],
    queryFn: () => fetchJson<GetGameResponse>(`${BASE}/${gameId}`),
    enabled: gameId !== null,
  });
}

export function useCreateGame(): ReturnType<typeof useMutation<CreateGameResponse>> {
  const qc = useQueryClient();
  return useMutation<CreateGameResponse>({
    mutationFn: () =>
      fetchJson<CreateGameResponse>(BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ era: 'ww2' }),
      }),
    onSuccess: (data) => {
      qc.setQueryData(['game', data.game.id], data);
    },
  });
}

export function useAttack(gameId: string): ReturnType<typeof useMutation<AttackResponse, Error, AttackBody>> {
  const qc = useQueryClient();
  return useMutation<AttackResponse, Error, AttackBody>({
    mutationFn: (body) =>
      fetchJson<AttackResponse>(`${BASE}/${gameId}/attack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => {
      qc.setQueryData(['game', gameId], { game: data.game });
    },
  });
}

export function useEndTurn(gameId: string): ReturnType<typeof useMutation<EndTurnResponse>> {
  const qc = useQueryClient();
  return useMutation<EndTurnResponse>({
    mutationFn: () =>
      fetchJson<EndTurnResponse>(`${BASE}/${gameId}/end-turn`, { method: 'POST' }),
    onSuccess: (data) => {
      qc.setQueryData(['game', gameId], { game: data.game });
    },
  });
}

export function useResetGame(gameId: string): ReturnType<typeof useMutation<ResetGameResponse>> {
  const qc = useQueryClient();
  return useMutation<ResetGameResponse>({
    mutationFn: () =>
      fetchJson<ResetGameResponse>(`${BASE}/${gameId}/reset`, { method: 'POST' }),
    onSuccess: (data) => {
      qc.setQueryData(['game', gameId], { game: data.game });
    },
  });
}
