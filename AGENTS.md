<!-- >>> dotfiles cursor-cloud >>> -->
<!-- Managed by `dotfiles install` / `dotfiles install-cloud-agent`. Do not edit by hand. -->

## Cursor Cloud specific instructions

- **dotfiles** lives at `$HOME/dotfiles` (override with `DOTFILES_HOME`).
- **DKR** lives at `$HOME/DKR` (override with `DKR_HOME`).
- Before writing or pushing code, run `dotfiles setup --non-interactive` (or `bash .cursor/bootstrap.sh` on a cold Build).
- The bootstrap clones `dotfiles` and `DKR` with ONE credential (GitHub App `DKR_APP_ID` + `DKR_APP_PRIVATE_KEY`, else `GH_CLAUDE_SECRET`). That credential is not DKR-only: it must read the product repo, `DKR` and `dotfiles`. If a clone is rejected, run `node .dkr/bin/paired-push.mjs --mint-token --repos avoidTheLite/dotfiles,avoidTheLite/DKR >/dev/null` and report which repo the App/PAT lacks; never print the token.
- If either repo is missing after bootstrap, **stop and report** — do not continue, invent a path, or skip setup.
- Generator-owned paths (`.cursor/`, and when present `.claude/` / `.github/` from the CLI) must not be hand-edited in this product repo; change templates in `avoidTheLite/dotfiles` and re-run `dotfiles install-cloud-agent` (or regenerate).

<!-- <<< dotfiles cursor-cloud <<< -->

<!-- >>> dotfiles paired-workspace >>> -->
<!-- Managed by `dotfiles install-dkr`. Do not edit this section by hand; re-run install-dkr to refresh. -->

## Paired workspace (product ↔ DKR)

This repository is one half of a **paired multi-repo workspace**. Application code lives here
(`avoidTheLite/elevate-combat`). Domain knowledge lives in `avoidTheLite/DKR`, checked out as a sparse git
submodule at `dkr/`. Both halves are one unit of work.

Canonical knowledge and the full agent audit live **in the DKR checkout** (do not duplicate them
into product docs):

| Topic | Start here |
| --- | --- |
| DKR entry / routing | `dkr/AGENTS.md` |
| This product's folder | `dkr/(no product folder mapped yet)` |
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
  `dkr/(no product folder mapped yet)`.
- Only these DKR paths are checked out (sparse cone):
  - `dkr/domains/pde/dkr/features/outputs/`
  - `dkr/domains/pde/dkr/features/pipeline/`
  - `dkr/domains/pde/dkr/features/lifecycle/`
  - `dkr/domains/pde/dotfiles/`
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

### Branch invariants

- Both repositories use the **same branch name**. The wrapper creates or switches the DKR branch
  to match this one.
- Branch names must match `^(feature|fix|chore|docs|refactor|test|cursor|claude)/([A-Z][A-Z0-9]*-[0-9]+-)?[a-z0-9][a-z0-9-]*$`
  (examples: `feature/add-login`, `fix/PROJ-42-null-session`, `docs/paired-workspace`, `cursor/dkr-agent-review-checklist-f61f`, `claude/dotfiles-paired-multi-repo-pcz9u9`). Pushes from `main`, `master`, `develop` are refused.
<!-- <<< dotfiles paired-workspace <<< -->
