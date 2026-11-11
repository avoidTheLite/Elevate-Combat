import { create } from 'zustand';
import type {
  CampaignNodeActionChoice,
  CampaignNodeView,
  GameState,
  Team,
} from '@iron-ridge/engine';
import { campaignNodeActionChoices, campaignNodeViews } from '@iron-ridge/engine';
import { strategicKnowledge } from '../lib/strategicVisibility.ts';

export interface NodePlacementPlan {
  nodeId: string;
  mainHex: string;
  definitionId: string;
  tier: 1 | 2 | 3;
  view: Team | null;
  subHex: string | null;
  /** The exact engine quote accepted when the player picked a location. */
  choice: CampaignNodeActionChoice | null;
}

export function visibleNodeActionChoices(
  game: GameState,
  node: CampaignNodeView,
  view: Team | null,
): CampaignNodeActionChoice[] {
  if (view !== null && view !== game.active) return [];
  const knowledge = strategicKnowledge(game, view);
  if (!knowledge.mains.has(node.mainHex)) return [];
  const own = view === null || node.owner === view;
  return campaignNodeActionChoices(game, node.nodeId).filter((choice) => {
    const request = choice.request;
    if (!own && (request.kind !== 'activate' || !choice.legal)) return false;
    const tile =
      request.kind === 'build'
        ? request.subHex
        : request.kind === 'activate'
          ? node.centerSubHex
          : node.buildings.find((building) => building.id === request.buildingId)?.subHex;
    return !!tile && knowledge.cells.has(tile);
  });
}

function placementChoices(game: GameState, plan: NodePlacementPlan): CampaignNodeActionChoice[] {
  const node = campaignNodeViews(game).find(
    (candidate) => candidate.nodeId === plan.nodeId && candidate.mainHex === plan.mainHex,
  );
  if (!node) return [];
  return visibleNodeActionChoices(game, node, plan.view).filter(
    ({ request }) =>
      request.kind === 'build' &&
      request.definitionId === plan.definitionId &&
      request.tier === plan.tier,
  );
}

/** Highlights use the same validated, currently visible choices as confirmation. */
export function nodePlacementTargets(
  game: GameState,
  plan: NodePlacementPlan | null,
): readonly string[] {
  if (!plan) return [];
  return placementChoices(game, plan).flatMap((choice) =>
    choice.legal && choice.request.kind === 'build' ? [choice.request.subHex] : [],
  );
}

export function currentNodeQuote(
  game: GameState,
  node: CampaignNodeView,
  view: Team | null,
  quoted: CampaignNodeActionChoice,
): CampaignNodeActionChoice | null {
  return (
    visibleNodeActionChoices(game, node, view).find(
      (choice) =>
        JSON.stringify(choice.request) === JSON.stringify(quoted.request) &&
        choice.cpCost === quoted.cpCost,
    ) ?? null
  );
}

interface NodePlacementStore {
  plan: NodePlacementPlan | null;
  startPlacement: (plan: Omit<NodePlacementPlan, 'choice' | 'subHex'>) => void;
  selectTile: (game: GameState, subHex: string) => boolean;
  cancelPlacement: () => void;
}

/** A transient UI plan: never persisted in GameState or included in a save. */
export const useNodePlacementStore = create<NodePlacementStore>((set, get) => ({
  plan: null,
  startPlacement: (plan) => set({ plan: { ...plan, subHex: null, choice: null } }),
  selectTile: (game, subHex) => {
    const plan = get().plan;
    if (!plan) return false;
    const choice = placementChoices(game, plan).find(
      (candidate) =>
        candidate.legal &&
        candidate.request.kind === 'build' &&
        candidate.request.subHex === subHex,
    );
    if (!choice) return false;
    set({ plan: { ...plan, subHex, choice } });
    return true;
  },
  cancelPlacement: () => set({ plan: null }),
}));
