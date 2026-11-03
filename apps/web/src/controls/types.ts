/** Map-local coordinates, projected again whenever the camera changes. */
export interface SceneTileAnchor {
  key: string;
  x: number;
  y: number;
  radius: number;
  width: number;
  height: number;
}

export interface SceneInteraction {
  source: 'click' | 'drag' | 'context';
  stage?: 'start' | 'move' | 'end' | 'cancel';
  originKey: string | null;
  targetKey: string | null;
  button: number;
  pointerType?: string;
}

export interface SceneCommandControls {
  enabled?: boolean;
  /** Changes for session, game revision or actor changes, even at the same tile. */
  selectionScope?: string | null;
  selectedOriginKey: string | null;
  protectedKeys: readonly string[];
  trackedKeys: readonly string[];
  onInteraction: (intent: SceneInteraction) => void;
  onLayout: (anchors: readonly SceneTileAnchor[]) => void;
}
