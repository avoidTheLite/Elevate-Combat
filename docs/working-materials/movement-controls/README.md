# Movement controls feedback demo

Use branch `feature/movement-controls-demo`. The commander-movement fix has merged; this demo targets main and retains that correction. The demo itself remains unmerged.

From the repository root, using Node 22 or later and the pinned pnpm 12.6.0:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @iron-ridge/web dev --host 127.0.0.1
```

Open the local URL printed by Vite. On setup choose **OPEN PREPARED TACTICAL CONTROLS** for immediate movement, attack and existing engineer/fixed-weapon operations, or **START READY MOVEMENT CAMPAIGN** for the regular sparse strategic-objectives game. These explicit starts replace the browser's current autosave; export any game you want to preserve first. Existing Continue/import flows remain available.

Use **DEMO CONTROLS** for the proposed, adjustable browser preferences. Move/Attack clicks preview by default; **Confirm** executes. Quick Move and Quick Attack can be enabled separately. Selected-unit drags always preview and require confirmation in this proposal. Other drags pan. Selection alone opens no popup. Use hover/context or the camera toolbar **ACTIONS** shortcut for contextual tile controls. Descriptions and detailed preview statistics are in hover/accessibility descriptions and optional Help. On mobile the **DETAILS** toggle exposes the retained sidebar.

Canonical intake, design decisions, complete review steps, screenshots and immutable verification live in the matching DKR campaign stage at `features/campaign/stages/03-execution/movement-controls/README.md`; this folder contains only runnable browser proof scripts and launch notes. The demo does not finalize its open design choices or change engine rules.

The browser scripts use the managed cloud Chromium/Playwright paths documented in their source, inspect the real renderer/store, and interact through actual browser input. They never dispatch fabricated game outcomes. Run them from the repository root while Vite is running:

```sh
node docs/working-materials/movement-controls/browser-commands.mjs
node docs/working-materials/movement-controls/browser-input.mjs
node docs/working-materials/movement-controls/browser-feedback.mjs
```

Output defaults to `/tmp/ux-controls-commands` and `/tmp/ux-controls-input`. `QA_URL` and `UX_EVIDENCE_DIR` can override the URL/output for the command script; see the input script's environment names for its output override. Physical-device long-press behavior is a separate verification limit.

The November 4 review follow-up adds fog-safe blind-fire details and retained per-player strategic ownership. One visible SubHex updates its MainHex owner; occlusion keeps the last observation. Saves now use schema 5; older saves initialize only currently visible ownership, with no retroactive knowledge of hidden changes.

Additional reproducible proof (prepared initial fixtures are imported through the ordinary save UI; no fabricated combat outcomes):

```sh
node docs/working-materials/movement-controls/browser-review.mjs
node docs/working-materials/movement-controls/browser-ownership.mjs
```

See the DKR execution guide’s PR-feedback section for pinned results and the independent review. The Copilot setup job’s private CLI clone authentication failure is a separate environment limitation; the review comments themselves were available and addressed.
