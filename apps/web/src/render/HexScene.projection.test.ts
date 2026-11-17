import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { edgeCorners, hexToWorld } from '@iron-ridge/engine';
import { HexScene } from './HexScene.ts';
import { topY } from './spec.ts';
import type { CellSpec } from './spec.ts';
import type { SceneCommandControls, SceneTileAnchor } from '../controls/types.ts';
import { projectedTileAnchor } from '../controls/projection.ts';
import type { ScreenPoint } from '../controls/projection.ts';

interface ProjectedTile {
  center: ScreenPoint;
  corners: ScreenPoint[];
}

interface ProjectionHarness {
  world: THREE.Group;
  ortho: THREE.OrthographicCamera;
  persp: THREE.PerspectiveCamera;
  fireView: { from: string; to: string } | null;
  fireEnabled: boolean;
  commandControls: SceneCommandControls;
  lastLayout: SceneTileAnchor[];
  projectKey: HexScene['projectKey'];
  projectTile: (key: string) => ProjectedTile | null;
  updateCommandLayout: () => void;
}

interface Fixture {
  scene: ProjectionHarness;
  root: THREE.Scene;
  parent: THREE.Group;
  world: THREE.Group;
  model: THREE.Group;
  mesh: THREE.Object3D;
  cells: CellSpec[];
  viewport: { width: number; height: number };
  expectedTile: (cell: CellSpec) => ProjectedTile;
}

/** Real projection math without a WebGL context or animation loop. */
function harness(): Fixture {
  const root = new THREE.Scene();
  const parent = new THREE.Group();
  const world = new THREE.Group();
  root.add(parent);
  parent.add(world);
  const model = new THREE.Group();
  const mesh = new THREE.Object3D();
  model.add(mesh);
  world.add(model);
  const viewport = { width: 1280, height: 720 };
  const container = document.createElement('div');
  Object.defineProperties(container, {
    clientWidth: { get: () => viewport.width },
    clientHeight: { get: () => viewport.height },
  });
  const ortho = new THREE.OrthographicCamera(-20, 20, 12, -12, 0.1, 500);
  const persp = new THREE.PerspectiveCamera(50, viewport.width / viewport.height, 0.1, 500);
  for (const camera of [ortho, persp]) {
    camera.position.set(20, 40, 35);
    camera.lookAt(0, 0, 0);
  }
  const cells: CellSpec[] = [
    { key: '0,0', q: 0, r: 0, h: 2, fill: 0, line: 0 },
    { key: '1,0', q: 1, r: 0, h: 1, fill: 0, line: 0 },
  ];
  const scene = Object.assign(Object.create(HexScene.prototype), {
    world,
    ortho,
    persp,
    container,
    renderer: {
      domElement: {
        getBoundingClientRect: () => ({
          left: 13,
          top: 21,
          width: viewport.width,
          height: viewport.height,
        }),
      },
    },
    cells,
    cellIndex: new Map(cells.map((cell, i) => [cell.key, i])),
    fireView: null,
    fireEnabled: false,
    commandControls: {
      enabled: true,
      selectedOriginKey: '0,0',
      trackedKeys: ['0,0', '1,0'],
      protectedKeys: [],
      onInteraction: () => false,
      onLayout: () => {},
    },
    lastLayout: [],
  }) as ProjectionHarness;

  // Compute the reference from local transforms, independently of cached world
  // matrices and the scene's projection helpers.
  function expectedTile(cell: CellSpec): ProjectedTile {
    root.updateMatrix();
    parent.updateMatrix();
    world.updateMatrix();
    const worldMatrix = new THREE.Matrix4()
      .multiplyMatrices(root.matrix, parent.matrix)
      .multiply(world.matrix);
    const camera = scene.fireEnabled ? persp : ortho;
    camera.updateMatrix();
    const viewMatrix = camera.matrix.clone().invert();
    const project = (point: THREE.Vector3): ScreenPoint => {
      point
        .applyMatrix4(worldMatrix)
        .applyMatrix4(viewMatrix)
        .applyMatrix4(camera.projectionMatrix);
      return {
        x: ((point.x + 1) / 2) * viewport.width,
        y: ((1 - point.y) / 2) * viewport.height,
      };
    };
    const hex = hexToWorld(cell);
    const origin = new THREE.Vector3(hex.x, topY(cell.h), hex.z);
    return {
      center: project(origin.clone()),
      corners: Array.from({ length: 6 }, (_, direction) => {
        const [corner] = edgeCorners(direction, 0.985);
        return project(origin.clone().add(new THREE.Vector3(corner.x, 0, corner.z)));
      }),
    };
  }
  return { scene, root, parent, world, model, mesh, cells, viewport, expectedTile };
}

describe('GAMES-ELEVATE-CAMPAIGN-UC-002: tile projection transform scope', () => {
  it.each<[string, (fixture: Fixture) => void]>([
    ['initial camera', () => {}],
    [
      'world rotation, translation and scale',
      ({ world }) => {
        world.position.set(1, 0.7, -2);
        world.rotation.y = 0.31;
        world.scale.set(1.2, 0.9, 1.1);
      },
    ],
    [
      'dirty ancestor transforms',
      ({ root, parent }) => {
        root.position.set(0.4, 0.8, -0.2);
        root.rotation.y = -0.2;
        parent.position.set(1, 0.5, 2);
        parent.scale.set(0.8, 1.2, 1.1);
      },
    ],
    [
      'camera pan, rotation and zoom',
      ({ scene }) => {
        scene.ortho.position.set(30, 45, 50);
        scene.ortho.lookAt(2, 1, -5);
        scene.ortho.zoom = 1.4;
        scene.ortho.updateProjectionMatrix();
      },
    ],
    [
      'resized viewport',
      ({ scene, viewport }) => {
        viewport.width = 390;
        viewport.height = 844;
        scene.ortho.left = (-12 * viewport.width) / viewport.height;
        scene.ortho.right = -scene.ortho.left;
        scene.ortho.updateProjectionMatrix();
      },
    ],
    [
      'perspective firing camera',
      ({ scene }) => {
        scene.fireView = { from: '0,0', to: '1,0' };
        scene.fireEnabled = true;
        scene.persp.position.set(3, 12, 20);
        scene.persp.lookAt(1, 1, 0);
      },
    ],
  ])(
    'projects current tile coordinates with %s without updating token descendants',
    (_, mutate) => {
      const fixture = harness();
      const { scene, cells, model, mesh, expectedTile } = fixture;
      scene.updateCommandLayout();
      mutate(fixture);
      model.position.set(7, 8, 9);
      mesh.position.set(1, 2, 3);
      model.matrixWorld.makeTranslation(100, 200, 300);
      mesh.matrixWorld.makeTranslation(400, 500, 600);
      const modelMatrix = model.matrixWorld.clone();
      const meshMatrix = mesh.matrixWorld.clone();
      const expectedAnchors: SceneTileAnchor[] = [];

      for (const cell of cells) {
        const expected = expectedTile(cell);
        const tile = scene.projectTile(cell.key)!;
        expect(tile).not.toBeNull();
        for (const [actual, reference] of [
          [tile.center, expected.center],
          ...tile.corners.map((corner, i) => [corner, expected.corners[i]!]),
        ]) {
          expect(actual!.x).toBeCloseTo(reference!.x, 9);
          expect(actual!.y).toBeCloseTo(reference!.y, 9);
        }
        const client = scene.projectKey(cell.key)!;
        expect(client.x).toBeCloseTo(expected.center.x + 13, 9);
        expect(client.y).toBeCloseTo(expected.center.y + 21, 9);
        expectedAnchors.push(projectedTileAnchor(cell.key, expected.center, expected.corners)!);
      }
      scene.updateCommandLayout();
      expect(scene.lastLayout).toHaveLength(cells.length);
      for (const [i, anchor] of scene.lastLayout.entries()) {
        const reference = expectedAnchors[i]!;
        expect(anchor.key).toBe(reference.key);
        for (const field of ['x', 'y', 'radius', 'width', 'height'] as const)
          expect(anchor[field]).toBeCloseTo(reference[field], 9);
      }
      // Projection must leave dirty model transforms for the renderer to update.
      expect(model.matrixWorld).toEqual(modelMatrix);
      expect(mesh.matrixWorld).toEqual(meshMatrix);
    },
  );
});
