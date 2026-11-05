# Movement controls review

Review branch: `feature/compact-command-previews`. The earlier movement-control PRs #18/#209 have merged. The compact preview draft pair is game PR #19 and DKR #218. This review does not merge or deploy a site.

From the product root, with Node 22+ and pnpm 12.6.0:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @iron-ridge/web dev --host 127.0.0.1
```

Open Vite's local URL. Choose **OPEN PREPARED TACTICAL CONTROLS** or **START READY MOVEMENT CAMPAIGN**. Explicit starts replace the browser autosave; export a game to preserve first. Continue and save import remain available.

Preview movement to see one green route and two check/X controls inside the destination hex. Preview an attack to see one red arrow and the existing Help/confirmation controls. Quick Move and Quick Attack remain separate preferences in **DEMO CONTROLS**. The check/X controls preserve keyboard and touch access; reduced motion makes the new animation static.

Canonical intake, implementation choices, review steps and evidence live in the paired DKR at `domains/games/Elevate-Combat/features/campaign/stages/03-execution/movement-controls/COMPACT_PREVIEWS.md`. This product folder holds launch notes and runnable proof only.

Run the current browser proof from the product root while Vite is running:

```sh
node docs/working-materials/movement-controls/browser-compact-previews.mjs
```

It uses the managed Chromium/Playwright paths in its source, ordinary browser input and read-only DEV state/projection inspection. Prepared fog fixtures enter through the ordinary save import UI. Output defaults to `/tmp/compact-previews/browser`; `QA_URL` and `COMPACT_EVIDENCE_DIR` override URL/output. Touch is CDP emulation rather than physical-device validation.

The older `browser-commands`, `browser-input`, `browser-feedback`, `browser-review` and `browser-ownership` scripts remain historical proof for the earlier interface. Some intentionally expect the superseded movement confirmation card; their pinned results remain in DKR history. Use the compact-preview script for this increment.
