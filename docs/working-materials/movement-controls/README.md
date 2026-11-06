# Movement controls review

Review branch: `feature/compact-command-previews`. The earlier movement-control PRs #18/#209 have merged. The compact preview draft pair is game PR #19 and DKR #218. This review does not merge or deploy a site.

From the product root, with Node 22+ and pnpm 12.6.0:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @iron-ridge/web dev --host 127.0.0.1
```

Open Vite's local URL. Home offers **CREATE CAMPAIGN**, **PLAY SCENARIO**, **RESUME GAME**, **QUICK START TACTICAL CONTROLS** and shared **SETTINGS**. Use Play Scenario → Ready Regular Campaign → Start Scenario for the regular sparse-objective campaign, or apply its editable campaign preset in Create Campaign. Explicit starts replace the browser autosave; export a game to preserve it first.

Map inspection, contextual building selection and persistent turn controls share the existing interface. Compact movement/attack check/X and directional arrows remain available. Player preferences and presets are stored separately from exact game saves. The review guide lists bounded UI/storage choices and deferred node-menu exploration.

Canonical intake, implementation choices, review steps and evidence live in the paired DKR at `domains/games/Elevate-Combat/features/campaign/stages/03-execution/movement-controls/INTERFACE_REVIEW.md`. This product folder holds launch notes and runnable proof only.

Run the current browser proof from the product root while Vite is running:

```sh
node docs/working-materials/movement-controls/browser-interface-review.mjs
```

It uses the managed Chromium/Playwright paths in its source, ordinary browser input and read-only DEV state/projection inspection. Prepared fog fixtures enter through the ordinary save import UI. Output defaults to `/tmp/compact-previews/browser`; `QA_URL` and `COMPACT_EVIDENCE_DIR` override URL/output. Touch is CDP emulation rather than physical-device validation.

The older `browser-commands`, `browser-input`, `browser-feedback`, `browser-review` and `browser-ownership` scripts remain historical proof for the earlier interface. Some intentionally expect the superseded movement confirmation card; their pinned results remain in DKR history. The previous compact-preview script also predates Home navigation. Use browser-interface-review.mjs for the current increment.
