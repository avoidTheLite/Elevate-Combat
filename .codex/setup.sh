#!/usr/bin/env bash
# dotfiles agent-env (generated). Paste into the Codex environment SETUP SCRIPT (secrets are typically
# only available during setup, and the agent phase may be offline), or call it from there.
# Only references the shared .dkr/agent-env/ files: setup.sh runs bootstrap.sh when the CLI is missing.
set -euo pipefail
# Unattended hosted profile: no prompts, and the App private key (if present) is dropped after the
# one scoped token is minted. Override with AGENT_ENV_PROFILE=human.
export AGENT_ENV_PROFILE="${AGENT_ENV_PROFILE:-codex-cloud}"
bash .dkr/agent-env/setup.sh
