#!/usr/bin/env bash
# Claude Code on the web SessionStart hook. Generator-owned (dotfiles install-cloud-agent).
# Cloud sessions only (CLAUDE_CODE_REMOTE=true); a no-op on local machines. Reuses the
# shared .cursor/bootstrap.sh so Cursor and Claude cloud agents provision identically.
# Never fails the session: stdout is added to Claude's context, so problems are reported there.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
bootstrap="${root}/.cursor/bootstrap.sh"
if [ ! -f "${bootstrap}" ]; then
  echo "cloud-agent hook: ${bootstrap} missing; run 'dotfiles install-cloud-agent'. Stop and report."
  exit 0
fi

if out="$(bash "${bootstrap}" 2>&1)"; then
  printf '%s\n' "${out}" | tail -n 8
else
  printf '%s\n' "${out}" | tail -n 25
  echo "cloud-agent hook: bootstrap FAILED. dotfiles and DKR must be attached to this session"
  echo "(Claude cloud only reaches GitHub repos attached to the session). Stop and report; do not skip setup."
fi
exit 0
