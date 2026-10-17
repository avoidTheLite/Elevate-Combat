<!-- >>> dotfiles cursor-cloud >>> -->
<!-- Managed by `dotfiles install` / `dotfiles install-cloud-agent`. Do not edit by hand. -->

## Cursor Cloud specific instructions

**Setup phase (Build / `.cursor/environment.json` install).** Runs `bash .dkr/agent-env/bootstrap.sh` through the thin `.cursor/bootstrap.sh` shim. It installs Node 24, installs the CLI pinned in `.dkr/config.json` (`cli.spec`) and runs `dotfiles setup --agent` (links `~/dotfiles` and `~/.local/bin/dotfiles` only; no shell, git or editor changes), hydrates the sparse `dkr/` for a paired product, then runs the product's `.dkr/agent-env/post-bootstrap.sh` if it has one. Do not re-run `dotfiles setup --non-interactive` by hand: that is the machine installer and the pinned bootstrap does not need it.

**Agent phase (your shell).** Install-time `PATH` exports do not carry over. `/exec-daemon/node` (v22) can come before the installed Node 24 and `~/.local/bin` may be missing from `PATH`, so a bare `node -v` or `dotfiles` can look wrong on a healthy environment.

- Run work through the product's package scripts (for example `pnpm …`), which use the pinned Node. If the product documents a readiness command (look in its `AGENTS.md` / `docs/`), run that first rather than checking `node -v`.
- To call the CLI directly: `export PATH="$HOME/.local/bin:$PATH"` (or use `$DOTFILES_HOME/scripts/dotfiles`).
- Treat Docker and local inference as optional: report them as skipped when absent, not as failures.

**Where things live.**

- **dotfiles** is at `$HOME/dotfiles` (override with `DOTFILES_HOME`).
- **DKR:** a paired product reads the sparse checkout at `dkr/` in this repo (hydrated by `dotfiles install-dkr`); do not use or create `$HOME/DKR` for it. A repo that is not paired, and Claude cloud sessions, may have a full clone at `$HOME/DKR` (override with `DKR_HOME`).

**Credentials (setup phase).** The bootstrap clones `dotfiles` and the DKR with ONE credential set as an environment (Build) secret: GitHub App `DKR_APP_ID` + `DKR_APP_PRIVATE_KEY`, else `GH_CLAUDE_SECRET`. That credential is not DKR-only: it must read the product repo, `DKR` and `dotfiles`. If a clone is rejected, run `node .dkr/bin/paired-push.mjs --mint-token --repos avoidTheLite/dotfiles,avoidTheLite/DKR >/dev/null` and report which repo the App/PAT lacks; never print the token. Runtime provider keys are optional (demo mode).

- If a required repo is missing after bootstrap, **stop and report**: do not continue, invent a path, or skip setup.
- Generator-owned paths (`.cursor/`, `.dkr/agent-env/`, and when present `.claude/` / `.github/` from the CLI) must not be hand-edited in this product repo; change templates in `avoidTheLite/dotfiles` and re-run `dotfiles agent-env init` (or `install-cloud-agent`).

<!-- <<< dotfiles cursor-cloud <<< -->

<!-- >>> dotfiles paired-workspace >>> -->
<!-- Managed by `dotfiles install-dkr`. Do not edit this section by hand; re-run install-dkr to refresh. -->

## Paired workspace (product ↔ DKR)

This repository is one half of a **paired multi-repo workspace**. Application code lives here
(`avoidTheLite/Elevate-Combat`). Domain knowledge lives in `avoidTheLite/DKR`, checked out as a sparse git
submodule at `dkr/`. Both halves are one unit of work.

Canonical knowledge and the full agent audit live **in the DKR checkout** (do not duplicate them
into product docs):

| Topic | Start here |
| --- | --- |
| DKR entry / routing | `dkr/AGENTS.md` |
| This product's folder | `dkr/domains/games/Elevate-Combat/` |
| Paired use cases | `dkr/domains/pde/dotfiles/features/paired/USE_CASES.md` |
| Fail-closed agent checklist | `dkr/domains/pde/dotfiles/features/paired/AGENT_CHECKLIST.md` |
| Twin-PR policy (when Kong truth changes) | `dkr/domains/pde/dotfiles/features/twin/` |

### Context: read and index both trees

- Treat `dkr/` as first-class source, not vendored or generated files. Index it, search it,
  and watch it for changes alongside the application code.
- A change to behavior here may need a matching change under `dkr/`, and the reverse.
  Before you finish, run both:

  ```sh
  git status --short
  git -C dkr status --short
  git diff --submodule=log
  ```

- Start in the DKR at `dkr/AGENTS.md`. This product's knowledge is
  `dkr/domains/games/Elevate-Combat/`.
- Only these DKR paths are checked out (sparse cone):
  - `dkr/domains/pde/dkr/features/outputs/`
  - `dkr/domains/pde/dkr/features/pipeline/`
  - `dkr/domains/pde/dkr/features/lifecycle/`
  - `dkr/domains/pde/dotfiles/`
  - `dkr/domains/games/Elevate-Combat/`
  - `dkr/domains/games/domain-config/`
  Do not widen the sparse checkout or read other products' trees. Re-run `dotfiles install-dkr`
  to refresh the profile.
- The submodule has `update = none`. Do not run `git submodule update` on it; `dotfiles install-dkr`
  owns hydration. If `dkr/` is missing or empty, run `dotfiles install-dkr`.

### Twin intent (product ↔ DKR policy)

Before substantive work:

```sh
dotfiles dkr intent --mode <implement|amend|declare-done|none> --refs <UC…> --pin
```

- `amend` / `declare-done` → also run `dotfiles dkr pair`.
- Before done: `dotfiles dkr validate --clone` and follow
  `dkr/domains/pde/dotfiles/features/paired/AGENT_CHECKLIST.md`.

### Pushing: wrapper only

- **Never run `git push`** here or inside `dkr/`. A pre-push hook rejects raw pushes.
- Push with the wrapper from this repository root:

  ```sh
  node .dkr/bin/paired-push.mjs -m "<summary>" [--dkr-message "<summary>"]
  ```

  It verifies the branch, commits and pushes `dkr/` to the DKR remote, stages the updated
  submodule pointer with the code changes, commits, pushes this repository to its own remote, and
  prints the companion PR cross-links. Paste those into both PR bodies.
- Do not commit inside `dkr/` by hand, and do not commit a submodule pointer that has not
  been pushed.
- Merge the companion DKR PR with a merge commit. Repoint only when the pointer left the DKR remote:
  `node .dkr/bin/paired-push.mjs --repoint` checks first and is a no-op otherwise.
- If `dotfiles dkr validate` reports `dkr/pointer-mergeable` (another paired PR moved the pointer),
  run `node .dkr/bin/paired-push.mjs --sync`, resolve any conflict it names, then push as above.

### Branch invariants

- Both repositories use the **same branch name**. The wrapper creates or switches the DKR branch
  to match this one.
- Branch names must match `^(feature|fix|chore|docs|refactor|test|cursor|claude)/([A-Z][A-Z0-9]*-[0-9]+-)?[a-z0-9][a-z0-9-]*$`
  (examples: `feature/add-login`, `fix/PROJ-42-null-session`, `docs/paired-workspace`, `cursor/dkr-agent-review-checklist-f61f`, `claude/dotfiles-paired-multi-repo-pcz9u9`). Pushes from `main`, `master`, `develop` are refused.
<!-- <<< dotfiles paired-workspace <<< -->
