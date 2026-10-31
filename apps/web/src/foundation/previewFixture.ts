import { beginFoundationCapture, projectTerritorialControl } from '@iron-ridge/engine';
import type {
  FoundationCaptureEvent,
  FoundationCaptureState,
  TerritorialControl,
} from '@iron-ridge/engine';

export const PREVIEW_LABELS = { crossroads: 'Crossroads', ridge: 'Ridge Outpost' };
export const PREVIEW_TURN = { team: 'A' as const, id: 'preview-A-turn-1' };

// Explicit synthetic fixture values, never the production capture profile.
export function createCapturePreview(
  event: FoundationCaptureEvent['kind'],
): FoundationCaptureState {
  const nodes = [
    { id: 'crossroads', mainHex: '0,0', centerSubHex: '0,0', owner: 'B' as const },
    { id: 'ridge', mainHex: '1,0', centerSubHex: '3,0', owner: 'B' as const },
  ].map((node) => ({
    ...node,
    buildings: [{ id: `${node.id}-center`, ruined: false, data: { role: 'generic', tier: 1 } }],
  }));
  const state: FoundationCaptureState = {
    version: 0,
    work: {
      version: 0,
      commandPoints: { A: 10, B: 10 },
      nodeSpending: [],
      engineerSpending: [],
      receipts: [],
    },
    nodes,
    pending: null,
    receipts: [],
  };
  const timing: FoundationCaptureEvent =
    event === 'turn-start-after-income'
      ? { kind: event, incomeReceiptId: 'preview-income-paid' }
      : event === 'manual-battle-end'
        ? { kind: event, battleId: 'preview-manual-battle' }
        : { kind: event, movementReceiptId: 'preview-strategic-move' };
  const result = beginFoundationCapture(
    state,
    { requestId: 'preview-capture-batch', expectedVersion: state.version },
    {
      snapshotVersion: state.version,
      ownerTurn: PREVIEW_TURN,
      event: timing,
      costs: { capture: 7, raze: 3 },
      candidates: nodes.map((node) => ({
        nodeId: node.id,
        liveGarrisonUnitIds: [],
        liveCenterOccupants: [{ unitId: `${node.id}-attacker`, team: 'A' }],
        liveHostileMainHexUnitIds: event === 'manual-battle-end' ? [`${node.id}-enemy`] : [],
        commanders: [
          {
            id: `${node.id}-commander`,
            team: 'A',
            mainHex: node.mainHex,
            subHex: node.centerSubHex,
            living: true,
          },
        ],
      })),
    },
  );
  if (!result.ok) throw new Error(result.reason);
  return result.state;
}

export function capturePreviewControl(
  state: FoundationCaptureState,
  event: FoundationCaptureEvent['kind'],
): TerritorialControl {
  return projectTerritorialControl({
    mainHexIds: state.nodes.map((node) => node.mainHex),
    nodes: state.nodes.map((node) => ({ id: node.id, mainHexId: node.mainHex, owner: node.owner })),
    holders: state.nodes.flatMap((node) => [
      {
        id: `${node.id}-attacker`,
        mainHexId: node.mainHex,
        team: 'A' as const,
        livingUnitIds: [`${node.id}-attacker-unit`],
      },
      ...(event === 'manual-battle-end'
        ? [
            {
              id: `${node.id}-enemy`,
              mainHexId: node.mainHex,
              team: 'B' as const,
              livingUnitIds: [`${node.id}-enemy-unit`],
            },
          ]
        : []),
    ]),
  });
}
