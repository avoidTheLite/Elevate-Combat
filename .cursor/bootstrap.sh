#!/usr/bin/env bash
# Cursor Cloud Agent shim. Generator-owned (dotfiles install-cloud-agent): do not hand-edit.
# The provisioning engine is shared by every agent platform and lives in .dkr/agent-env/.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
engine="${root}/.dkr/agent-env/bootstrap.sh"
if [ ! -f "${engine}" ]; then
  echo "cursor bootstrap: ${engine#"${root}"/} missing; run 'dotfiles agent-env init' (or 'dotfiles install-cloud-agent' on an unpaired repo). Stop and report." >&2
  exit 1
fi
exec bash "${engine}" "$@"
