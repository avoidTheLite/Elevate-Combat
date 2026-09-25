import type * as THREE from 'three';

export interface ModelOptions {
  color: number;
  opacity: number;
}

export interface Kit {
  root: THREE.Group;
  body: THREE.Material;
  light: THREE.Material;
  skin: THREE.Material;
  metal: THREE.Material;
  dark: THREE.Material;
  gold: THREE.Material;
  edge: THREE.LineBasicMaterial;
}

export type V3 = [number, number, number];

export interface FigureOpts {
  helmet?: boolean;
  hardHat?: boolean;
  scale?: number;
  y?: number;
}
