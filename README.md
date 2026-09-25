# Iron Ridge — V0.9

Iron Ridge is a turn-based strategy game with two layers: a strategic hex campaign, and tactical
battles fought on a nested sub-hex grid. The whole game is drawn in an isometric 3D view.

The design sources are in [`docs/`](docs/). Every assumption this build made to fill gaps in those
docs is listed in [`docs/V0.9_ASSUMPTIONS.md`](docs/V0.9_ASSUMPTIONS.md).

## Run

```sh
pnpm install
pnpm --filter @iron-ridge/web dev     # open the printed URL
```

## Test

```sh
pnpm turbo run typecheck test --filter=@iron-ridge/engine --filter=@iron-ridge/web
```

## Layout

| Path | What |
|---|---|
| `packages/engine` | Pure TypeScript rules engine: hierarchical hex grid, terrain, LOS, combat, tactical and strategic state machines, AI |
| `apps/web` | React + three.js isometric client |
| `apps/api` | Legacy prototype API (unused by V0.9) |

## Controls

| Input | Action |
|---|---|
| WASD / arrow keys / drag | Pan the camera |
| Q / E | Rotate |
| Mouse wheel | Zoom |
| R | Reset the view |
| F | Firing view, while aiming at a target |
| Left-click | Select, move or attack |
| Right-click | Cancel |
