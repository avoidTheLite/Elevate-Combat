#!/usr/bin/env bash
# dotfiles agent-env (generated). Regenerate with: dotfiles agent-env init
# One setup entry point for every agent platform. Run it in the platform's SETUP phase
# (network and secrets are most reliable there), then the agent works against the on-disk dkr/.
# When the dotfiles CLI is not installed yet it runs the shared .dkr/agent-env/bootstrap.sh first
# (set AGENT_ENV_NO_BOOTSTRAP=1 to forbid that, e.g. an offline agent phase).
# Secrets are read by NAME from the environment; this script never prints them.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${root}"

for v in DKR_APP_ID DKR_APP_PRIVATE_KEY DKR_APP_INSTALLATION_ID GH_CLAUDE_SECRET DKR_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN; do
  # An unset Actions secret expands to "": treat as missing, not as a token.
  if [ -n "${!v:-}" ] && [ -z "${!v//[[:space:]]/}" ]; then unset "${v}"; fi
done

find_cli() {
  dotfiles_bin="$(command -v dotfiles || true)"
  if [ -z "${dotfiles_bin}" ]; then
    # ${root} first: in the dotfiles repo itself the checkout is the CLI.
    for c in "${DOTFILES_HOME:-}" "${root}" "${HOME}/dotfiles" "$(dirname "${root}")/dotfiles"; do
      if [ -n "${c}" ] && [ -x "${c}/scripts/dotfiles" ]; then dotfiles_bin="${c}/scripts/dotfiles"; break; fi
    done
  fi
}

find_cli
if [ -z "${dotfiles_bin}" ] && [ -z "${AGENT_ENV_NO_BOOTSTRAP:-}" ] && [ -f "${root}/.dkr/agent-env/bootstrap.sh" ]; then
  echo "agent-env: dotfiles CLI not found; running .dkr/agent-env/bootstrap.sh" >&2
  # The strict doctor below is the report; do not run it twice.
  AGENT_ENV_DOCTOR=skip bash "${root}/.dkr/agent-env/bootstrap.sh" || true
  find_cli
fi
if [ -z "${dotfiles_bin}" ]; then
  echo "agent-env: dotfiles CLI not found. Run bash .dkr/agent-env/bootstrap.sh (installs dotfiles + Node 24), or set DOTFILES_HOME." >&2
  exit 1
fi

if [ ! -e dkr/.git ]; then
  "${dotfiles_bin}" install-dkr
fi
exec "${dotfiles_bin}" agent-env doctor "$@"
