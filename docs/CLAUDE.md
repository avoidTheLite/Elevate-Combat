# Project Context for Claude Code

## Dotfiles Repository

This machine has a `dotfiles` folder checked out **at the same level as
this project**, inside the root working directory (i.e. `../dotfiles`
relative to any individual project folder). It is a clone of:

    github.com/avoidTheLite/dotfiles
    
## How to find the local dotfiles repository
- The local dotfiles checkout is at /home/metal/dotfiles.
- Agents should treat ~/dotfiles as the canonical location for machine-local shell, editor, and environment configuration.
- If you need to verify it from the shell, run:
  ```bash
  ls -la ~
  test -d ~/dotfiles && echo "dotfiles found" || echo "dotfiles missing"
  ```
- If a new repo needs dotfiles-based setup or local config patterns, inspect ~/dotfiles first.

Treat this repo as the single source of truth for development
environment, style, and agent-behavior conventions. **Read it before
writing any code**, in this order:

1. `dotfiles/STYLE_GUIDE.md` — canonical formatting/style rules
   (also mirrored into `eslint.base.js` and `prettier.base.js`)
2. `dotfiles/` agent rules (markdown) — permission framework and
   behavioral conventions for agents working in this environment.
   Core axiom: every destructive action must be recoverable. Git
   history is the designated recovery primitive — commit before any
   action that can't otherwise be undone.
3. Repo-local overrides, if present in the current project, take
   precedence over anything in dotfiles.

## Full-Stack JavaScript Template

The template specification is **self-contained in `dotfiles/STYLE_GUIDE.md`**
(and its mirrored `eslint.base.js` / `prettier.base.js`). Build new
apps directly from that spec — it is the source of truth, not a
derivative of any existing app.

- Stack in use: pnpm + Turborepo, Node 22, Vite, React 18,
  TypeScript, Tailwind CSS, CVA (class-variance-authority),
  shadcn/ui, TanStack, Zustand.
- Do not scaffold by copying or extending an app inside
  `battleship-mono`. The style guide alone should be sufficient to
  generate a correct, conformant app from scratch.

### battleship-mono's role: reference only

Treat the `battleship-mono` monorepo strictly as a **working
example for comparison** — not a scaffold source. Use it during:

- **Review/check passes** — after generating code, compare it
  against equivalent code in battleship-mono to confirm the style
  guide was interpreted correctly and consistently.
- **Planning** — when the style guide is ambiguous or silent on a
  specific pattern, look at how battleship-mono resolved it as a
  precedent, but flag the ambiguity rather than silently copying
  the precedent as if it were spec.

If battleship-mono and the style guide ever disagree, the style
guide wins — surface the discrepancy rather than defaulting to
whatever battleship-mono does.

## Scaffolding a New Project

Use `dotfiles/scripts/init-project.sh <project-name>` to copy
`dotfiles/project-template/` into place. That template's
`.eslintrc.js` / `.prettierrc.js` already extend the dotfiles base
configs via `$HOME`-resolved absolute paths — don't duplicate rules
locally. This applies whether the new app lives inside
battleship-mono or as a standalone project.

## Branching

Do not commit to `main`/`master`. Create a feature branch before
making changes. Use any branch-naming convention defined in
dotfiles if one exists; otherwise a descriptive `feature/<name>`
branch is fine.
