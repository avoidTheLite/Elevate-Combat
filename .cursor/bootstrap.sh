#!/usr/bin/env bash
# Idempotent Cursor Cloud Agent bootstrap for dotfiles-generated (and apply-target) repos.
# Clones avoidTheLite/dotfiles + avoidTheLite/DKR when missing, fast-forwards when present,
# ensures Node 24, runs `dotfiles setup --non-interactive`, then hydrates this product repo's
# sparse `dkr/` checkout (`dotfiles install-dkr`) when the repo is paired, and prints the
# `agent-env doctor` report so the install log says whether the agent is READY.
# Both repos are private and a cloud agent's own install token is usually scoped to the product
# repo only, so before cloning this mints ONE credential that covers dotfiles AND DKR (GitHub App
# installation token from DKR_APP_ID + DKR_APP_PRIVATE_KEY, else GH_CLAUDE_SECRET / GH_TOKEN) via
# the vendored .dkr/bin/paired-push.mjs. It is handed to git as ephemeral GIT_CONFIG_* env and is
# never written to .git/config or printed.
# Shared by Cursor Cloud Agent (install) and Claude Code on the web (.claude/hooks/cloud-bootstrap.sh).
# Claude cloud (CLAUDE_CODE_REMOTE=true): sessions run as root and GitHub is reachable only for
# repos attached to the session (via a proxy), so existing remotes are never rewritten and a
# sibling checkout of dotfiles/DKR next to the project is preferred over a fresh clone.
set -euo pipefail

NODE_VERSION="${DOTFILES_NODE_VERSION:-24.21.0}"

sibling_checkout() {
  # Claude cloud attaches extra repos beside the project; reuse them when present.
  if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ] && [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
    candidate="$(dirname "${CLAUDE_PROJECT_DIR}")/$1"
    if [ -d "${candidate}/.git" ]; then
      echo "${candidate}"
      return
    fi
  fi
  echo "${HOME}/$1"
}

DOTFILES_HOME="${DOTFILES_HOME:-$(sibling_checkout dotfiles)}"
DKR_HOME="${DKR_HOME:-$(sibling_checkout DKR)}"
DOTFILES_REPO="${DOTFILES_REPO:-https://github.com/avoidTheLite/dotfiles.git}"
DKR_REPO="${DKR_REPO:-https://github.com/avoidTheLite/DKR.git}"
PRODUCT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() {
  printf 'cloud-agent bootstrap: %s\n' "$*"
}

die() {
  printf 'cloud-agent bootstrap: ERROR: %s\n' "$*" >&2
  exit 1
}

node_major() {
  # Prefer an explicit binary so Cloud Agent PATH prefixes (e.g. /exec-daemon) cannot hide Node 24.
  if [ -x /usr/local/bin/node ]; then
    /usr/local/bin/node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0
  elif [ -x "${HOME}/.local/bin/node" ]; then
    "${HOME}/.local/bin/node" -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0
  elif command -v node >/dev/null 2>&1; then
    node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0
  else
    echo 0
  fi
}

prefer_node24_on_path() {
  if [ -x /usr/local/bin/node ]; then
    export PATH="/usr/local/bin:${PATH}"
  elif [ -x "${HOME}/.local/bin/node" ]; then
    export PATH="${HOME}/.local/bin:${PATH}"
  fi
  hash -r || true
}

ensure_node24() {
  major="$(node_major)"
  if [ "${major}" = "24" ]; then
    prefer_node24_on_path
    log "node already $(command -v node) ($(node -v))"
    return
  fi

  if command -v node >/dev/null 2>&1; then
    log "node $(node -v) is not 24.x; installing v${NODE_VERSION}"
  else
    log "node not found; installing v${NODE_VERSION}"
  fi

  arch="$(uname -m)"
  case "${arch}" in
    x86_64) node_arch="x64" ;;
    aarch64 | arm64) node_arch="arm64" ;;
    *) die "unsupported architecture for Node install: ${arch}" ;;
  esac

  tmp="$(mktemp -d)"
  tarball="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${tarball}" -o "${tmp}/${tarball}"
  tar -xJf "${tmp}/${tarball}" -C "${tmp}"
  trap_dir="${tmp}"
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo cp -a "${tmp}/node-v${NODE_VERSION}-linux-${node_arch}/." /usr/local/
  else
    mkdir -p "${HOME}/.local"
    cp -a "${tmp}/node-v${NODE_VERSION}-linux-${node_arch}/." "${HOME}/.local/"
  fi
  prefer_node24_on_path
  command -v node >/dev/null 2>&1 || die "node missing after install"
  major="$(node -p "process.versions.node.split('.')[0]")"
  [ "${major}" = "24" ] || die "expected Node 24 after install, got $(node -v) via $(command -v node)"
  rm -rf "${trap_dir}"
  log "node ready $(command -v node) ($(node -v))"
}

# owner/name from an https or scp-style GitHub URL.
repo_slug() {
  printf '%s' "$1" | sed -E 's#^(https?://([^/@]+@)?|git@)github\.com[:/]##; s#\.git$##; s#/+$##'
}

# Treat an unset Actions-style secret that expands to "" as missing.
for v in DKR_APP_ID DKR_APP_PRIVATE_KEY DKR_APP_INSTALLATION_ID GH_CLAUDE_SECRET DKR_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN; do
  if [ -n "${!v:-}" ] && [ -z "${!v//[[:space:]]/}" ]; then unset "${v}"; fi
done

GIT_AUTH_TOKEN=""

# Mint (or pick) one credential that can read dotfiles AND DKR. Failure is not fatal here: a
# public repo or a platform-provided credential may still clone, so we only warn.
mint_credential() {
  local minter="${PRODUCT_ROOT}/.dkr/bin/paired-push.mjs"
  if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
    log "auth: Claude cloud session; using the session's attached-repo access (no token injected)"
    return
  fi
  local have_cred=""
  for v in DKR_APP_ID GH_CLAUDE_SECRET DKR_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN; do
    [ -n "${!v:-}" ] && have_cred="1"
  done
  if [ -z "${have_cred}" ]; then
    log "auth: no DKR_APP_ID / GH_CLAUDE_SECRET / GH_TOKEN in this environment; cloning unauthenticated (private repos will fail)"
    return
  fi
  if [ ! -f "${minter}" ]; then
    # Older generated repos: fall back to a static secret directly; the App path needs the minter.
    for v in GH_CLAUDE_SECRET DKR_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN; do
      if [ -n "${!v:-}" ]; then GIT_AUTH_TOKEN="${!v}"; log "auth: using ${v} (re-run 'dotfiles install-cloud-agent' to enable GitHub App tokens)"; return; fi
    done
    log "auth: ${minter#"${PRODUCT_ROOT}"/} missing; re-run 'dotfiles install-cloud-agent' to enable GitHub App tokens"
    return
  fi
  local repos
  repos="$(repo_slug "${DOTFILES_REPO}"),$(repo_slug "${DKR_REPO}")"
  if GIT_AUTH_TOKEN="$(node "${minter}" --mint-token --repos "${repos}" 2> >(sed 's/^/cloud-agent bootstrap: auth: /' >&2))" && [ -n "${GIT_AUTH_TOKEN}" ]; then
    log "auth: credential ready for ${repos}"
  else
    GIT_AUTH_TOKEN=""
    log "auth: could not obtain a credential for ${repos}; clones will be unauthenticated"
  fi
}

# Run git with the credential as ephemeral config (never persisted). Falls back to a plain run
# when no credential exists, or when the authenticated attempt fails (covers a stale token on a
# repo the platform can already reach).
git_auth() {
  if [ -n "${GIT_AUTH_TOKEN}" ]; then
    local b64
    b64="$(printf 'x-access-token:%s' "${GIT_AUTH_TOKEN}" | base64 | tr -d '\n')"
    if GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1 \
      GIT_CONFIG_KEY_0="http.https://github.com/.extraheader" \
      GIT_CONFIG_VALUE_0="AUTHORIZATION: basic ${b64}" \
      git "$@"; then
      return 0
    fi
    log "auth: authenticated git operation failed; retrying without a credential"
  fi
  GIT_TERMINAL_PROMPT=0 git "$@"
}

ensure_repo() {
  url="$1"
  dest="$2"
  label="$3"
  ref="${4:-}"

  if [ -d "${dest}/.git" ]; then
    log "${label}: fetching ${dest}"
    if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
      git -C "${dest}" remote set-url origin "${url}"
    fi
    git_auth -C "${dest}" fetch --prune origin
    if [ -n "${ref}" ]; then
      if git -C "${dest}" show-ref --verify --quiet "refs/remotes/origin/${ref}"; then
        git -C "${dest}" checkout -B "${ref}" "origin/${ref}"
        git -C "${dest}" merge --ff-only "origin/${ref}"
      else
        git_auth -C "${dest}" fetch origin "${ref}"
        git -C "${dest}" checkout -B "${ref}" FETCH_HEAD
      fi
    else
      branch="$(git -C "${dest}" rev-parse --abbrev-ref HEAD)"
      if [ "${branch}" = "HEAD" ]; then
        if git -C "${dest}" show-ref --verify --quiet refs/remotes/origin/main; then
          git -C "${dest}" checkout -B main origin/main
          branch="main"
        else
          die "${label}: detached HEAD and no origin/main"
        fi
      fi
      if git -C "${dest}" show-ref --verify --quiet "refs/remotes/origin/${branch}"; then
        git -C "${dest}" merge --ff-only "origin/${branch}"
      else
        # Local topic branch (or agent worktree) with no matching remote yet — keep checkout as-is.
        log "${label}: no origin/${branch}; keeping local checkout"
      fi
    fi
    log "${label}: up to date at $(git -C "${dest}" rev-parse --short HEAD)"
    return
  fi

  if [ -e "${dest}" ] && [ ! -d "${dest}/.git" ]; then
    # Allow a symlink or worktree path that already contains the CLI (local agent testing).
    if [ -x "${dest}/scripts/dotfiles" ] || [ -f "${dest}/scripts/dotfiles" ]; then
      log "${label}: using existing checkout at ${dest}"
      return
    fi
    die "${label}: ${dest} exists but is not a git clone"
  fi

  log "${label}: cloning ${url} -> ${dest}"
  mkdir -p "$(dirname "${dest}")"
  if [ -n "${ref}" ]; then
    clone_cmd=(git_auth clone --branch "${ref}" "${url}" "${dest}")
  else
    clone_cmd=(git_auth clone "${url}" "${dest}")
  fi
  if ! "${clone_cmd[@]}"; then
    if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
      die "${label}: not attached to this Claude cloud session and the clone failed. Attach ${url%.git} to the session/routine (Claude cloud only reaches attached GitHub repos), then retry"
    fi
    die "${label}: clone of ${url} failed. The credential must be able to read ${url%.git}: install the GitHub App on that repo (or grant GH_CLAUDE_SECRET read access to it). Check with: node .dkr/bin/paired-push.mjs --mint-token --repos $(repo_slug "${url}") >/dev/null"
  fi
  log "${label}: cloned at $(git -C "${dest}" rev-parse --short HEAD)"
}

ensure_node24
mint_credential
ensure_repo "${DOTFILES_REPO}" "${DOTFILES_HOME}" "dotfiles" "${DOTFILES_REF:-}"
ensure_repo "${DKR_REPO}" "${DKR_HOME}" "DKR" "${DKR_REF:-}"

# Keep the historical ~/dotfiles path used by project-template lint paths.
if [ "${DOTFILES_HOME}" != "${HOME}/dotfiles" ]; then
  if [ -L "${HOME}/dotfiles" ] || [ ! -e "${HOME}/dotfiles" ]; then
    ln -sfn "${DOTFILES_HOME}" "${HOME}/dotfiles"
  fi
fi

DOTFILES_CLI="${DOTFILES_HOME}/scripts/dotfiles"
[ -x "${DOTFILES_CLI}" ] || [ -f "${DOTFILES_CLI}" ] || die "missing ${DOTFILES_CLI}"

log "running dotfiles setup --non-interactive"
"${DOTFILES_CLI}" setup --non-interactive

# Hydrate the product's sparse dkr/ (paired repos only). A fresh clone has the gitlink but no
# checkout; ~/DKR is a separate full clone and is not what agents should read. Not fatal: the
# doctor report below says what is missing, and the agent rules say to stop and report.
if [ -e "${PRODUCT_ROOT}/dkr/.git" ]; then
  log "dkr/: already hydrated"
elif [ -f "${PRODUCT_ROOT}/.dkr/config.json" ] && grep -q '"paired"' "${PRODUCT_ROOT}/.dkr/config.json"; then
  log "dkr/: hydrating the sparse DKR checkout (dotfiles install-dkr)"
  if ! (cd "${PRODUCT_ROOT}" && "${DOTFILES_CLI}" install-dkr "${PRODUCT_ROOT}"); then
    log "WARNING: install-dkr failed; dkr/ is not hydrated. See the doctor report below."
  fi
else
  log "dkr/: this repo is not paired (.dkr/config.json has no \"paired\" section); run 'dotfiles install-dkr' to pair it"
fi

log "agent-env doctor"
"${DOTFILES_CLI}" agent-env doctor "${PRODUCT_ROOT}" || log "doctor reported NOT READY (details above)"

cli_version="$("${DOTFILES_CLI}" --version 2>/dev/null || true)"
dkr_sha="$(git -C "${DKR_HOME}" rev-parse HEAD)"
dotfiles_sha="$(git -C "${DOTFILES_HOME}" rev-parse HEAD)"

echo "cloud-agent bootstrap: OK"
echo "  dotfiles CLI: ${cli_version}"
echo "  dotfiles SHA: ${dotfiles_sha}"
echo "  DKR SHA:      ${dkr_sha}"
echo "  DOTFILES_HOME: ${DOTFILES_HOME}"
echo "  DKR_HOME:      ${DKR_HOME}"
