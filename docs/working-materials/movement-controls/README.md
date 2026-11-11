# Movement controls review

Review branch: `feature/compact-command-previews`. The earlier movement-control PRs #18/#209 have merged. Game PR #19 and DKR #218 are ready for review. DKR stage artifacts remain drafts pending acceptance.

Start with the paired DKR [review entry](https://github.com/avoidTheLite/DKR/blob/feature/compact-command-previews/domains/games/Elevate-Combat/features/campaign/stages/03-execution/movement-controls/REVIEW.md) for the current increment, canonical scope links, immutable source pins, receipt ledger and limitations. This product folder holds launch notes and runnable proof.

## Launch

From the product root, with Node 22+ and pnpm 12.6.0:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @iron-ridge/web dev --host 127.0.0.1
```

Open Vite's local URL. **Quick Start Tactical Controls** supplies an immediate playable scene. **Play Scenario → Ready Regular Campaign → Start Scenario** launches the regular sparse-objective campaign. Create Campaign offers editable presets; Resume Game restores exact saves. Explicit starts replace the browser autosave; export a game to preserve it first.

## Tests and browser proof

Run the aggregate suite, typecheck and build from the product root:

```sh
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
```

The aggregate suite includes engine, web and API tests. Focused regressions and fresh foundation observations are recorded separately in the DKR review entry; their counts are subsets and must not be added to the aggregate.

Run a browser script from the product root while Vite is running. All accept `QA_URL` (default `http://127.0.0.1:5173/`) and use the managed Chromium/Playwright paths in their source.

| Scope | Command | Default report | Output directory override |
|---|---|---|---|
| Performance/accuracy lifecycle follow-up | `node docs/working-materials/movement-controls/browser-performance-accuracy.mjs` | `/tmp/performance-review/browser/browser-performance-accuracy.json` | `PERFORMANCE_EVIDENCE_DIR` |
| Accessibility, live preferences, garrison cards | `node docs/working-materials/movement-controls/browser-review-feedback.mjs` | `/tmp/interface-review2/browser/browser-review-feedback.json` | `REVIEW_EVIDENCE_DIR` |
| HQ-ring inspection and explicit navigation | `node docs/working-materials/movement-controls/browser-hq-context.mjs` | `/tmp/hq-context-review/browser/browser-hq-context.json` | `HQ_EVIDENCE_DIR` |
| Broad interface and setup | `node docs/working-materials/movement-controls/browser-interface-review.mjs` | `/tmp/interface-review/browser/browser-compact-previews.json` | `COMPACT_EVIDENCE_DIR` |

These scripts reproduce different scopes; running one does not rerun the others. They use ordinary browser input, read-only DEV state/projection inspection and camera adjustment. Prepared fixtures enter through the save importer. The accessibility script injects preference-key storage failures. Touch uses Chromium CDP emulation, with physical-device and prepared-fixture limits in the DKR guide. The current increment's executed scripts/results must be recorded in the review entry.

The performance/accuracy script distinguishes trusted pen-context events from touch button choices. Headless native touch-hold context menus were not observed in the separate capability probe; they remain unverified, rather than being inferred from a hover callout.

The older `browser-commands`, `browser-input`, `browser-feedback`, `browser-review`, `browser-ownership` and `browser-compact-previews` scripts remain historical proof for their pinned interfaces. Some expect superseded controls or predate Home navigation. Their retained results are historical receipts, not current-increment acceptance.
