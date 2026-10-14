#!/usr/bin/env node
/**
 * Transactional push for a paired multi-repo workspace (product repo + sparse DKR submodule).
 *
 * Self-contained on purpose: `dotfiles install-dkr` copies this file into product repos as
 * .dkr/bin/paired-push.mjs, so it may import only Node builtins.
 *
 * Order: verify branch -> commit + push the DKR submodule -> stage the gitlink with the
 * product changes, commit -> push the product -> print companion PR cross-links.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Resolve a `dotfiles` CLI that can run `dkr catch-up` (PATH, DOTFILES_ROOT, or sibling clone).
 * @param {string} productRoot
 * @returns {{ cmd: string, argsPrefix: string[] } | null}
 */
function resolveDotfilesCli(productRoot) {
  if (process.env.DKR_CATCHUP === '0') {
    return null;
  }
  const which = spawnSync('sh', ['-c', 'command -v dotfiles'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) {
    return { cmd: which.stdout.trim(), argsPrefix: [] };
  }
  const candidates = [
    process.env.DOTFILES_ROOT ? path.join(process.env.DOTFILES_ROOT, 'scripts', 'dotfiles') : null,
    process.env.DOTFILES_HOME ? path.join(process.env.DOTFILES_HOME, 'scripts', 'dotfiles') : null,
    path.join(productRoot, '..', 'dotfiles', 'scripts', 'dotfiles'),
    path.join(productRoot, 'scripts', 'dotfiles'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      // scripts/dotfiles is a shell wrapper; only .mjs entrypoints need node.
      if (candidate.endsWith('.mjs')) {
        return { cmd: process.execPath, argsPrefix: [candidate] };
      }
      return { cmd: candidate, argsPrefix: [] };
    }
  }
  return null;
}

/**
 * Before push: if twin mode lag exists, run `dotfiles dkr catch-up` so markers advance automatically.
 * @param {{ root: string, dkrDir: string, log: (line: string) => void, dryRun?: boolean }} input
 */
function runCatchUpBeforePush({ root, dkrDir, log, dryRun = false }) {
  const cli = resolveDotfilesCli(root);
  if (!cli) {
    log('catch-up: skipped (dotfiles CLI not found; set DOTFILES_ROOT/DOTFILES_HOME or put dotfiles on PATH)');
    return;
  }
  const args = [
    ...cli.argsPrefix,
    'dkr',
    'catch-up',
    '--write-twin-dir',
    dkrDir,
  ];
  if (dryRun) {
    args.push('--dry-run');
  }
  const result = spawnSync(cli.cmd, args, { cwd: root, encoding: 'utf8' });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (out) {
    for (const line of out.split('\n')) {
      log(`catch-up: ${line}`);
    }
  }
  if (result.status !== 0) {
    throw new Error(
      'catch-up failed before push. Fix twin sync (or DKR_CATCHUP=0 to skip) and retry.',
    );
  }
}

export const PAIRED_PUSH_ENV = 'DKR_PAIRED_PUSH';
export const DEFAULT_BRANCH_PATTERN =
  '^(feature|fix|chore|docs|refactor|test|cursor|claude)/([A-Z][A-Z0-9]*-[0-9]+-)?[a-z0-9][a-z0-9-]*$';
export const DEFAULT_PROTECTED = ['main', 'master', 'develop'];

/**
 * GitHub App credentials. A short-lived installation token is minted from these on demand, so
 * nothing needs rotating every 90 days. Names are temporary working names like the PAT ones
 * (PDE-DOTFILES-PAIRED-DP-005). `GITHUB_`-prefixed names are reserved for Actions secrets.
 */
export const APP_ENV = {
  id: 'DKR_APP_ID',
  key: 'DKR_APP_PRIVATE_KEY',
  installation: 'DKR_APP_INSTALLATION_ID',
  repo: 'DKR_APP_REPO',
  api: 'DKR_APP_API_URL',
};
const APP_MINT_INPUT_ENV = 'DKR_APP_MINT_INPUT';
const APP_REFRESH_SKEW_MS = 5 * 60 * 1000;
const appTokenCache = new Map();

function envValue(env, key) {
  const value = env[key];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/**
 * Platform env UIs mangle multi-line values, so accept a PEM, a PEM with literal `\n`, or the
 * base64 of a PEM, optionally wrapped in quotes.
 * @param {string} raw
 * @returns {string}
 */
export function normalizePrivateKey(raw) {
  let text = String(raw ?? '').trim().replace(/^(["'])([\s\S]*)\1$/, '$2').trim();
  if (!text.includes('-----BEGIN')) {
    const decoded = Buffer.from(text, 'base64').toString('utf8');
    if (decoded.includes('-----BEGIN')) {
      text = decoded;
    }
  }
  return `${text.replace(/\\n/g, '\n').trim()}\n`;
}

/**
 * Which App credentials the environment carries. Never returns a value.
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ state: 'none' | 'partial' | 'ready', missing: string[] }}
 */
export function appCredentialState(env = process.env) {
  const hasId = Boolean(envValue(env, APP_ENV.id));
  const hasKey = Boolean(envValue(env, APP_ENV.key));
  if (!hasId && !hasKey) {
    return { state: 'none', missing: [] };
  }
  const missing = [hasId ? '' : APP_ENV.id, hasKey ? '' : APP_ENV.key].filter(Boolean);
  return { state: missing.length ? 'partial' : 'ready', missing };
}

/**
 * Narrowest permissions that still do the job. `read` hydrates the DKR; `write` also opens twin
 * PRs. GitHub rejects a request for more than the App was granted.
 * @param {'read' | 'write'} access
 */
export function appPermissions(access) {
  return access === 'write'
    ? { contents: 'write', pull_requests: 'write', metadata: 'read' }
    : { contents: 'read', metadata: 'read' };
}

/**
 * RS256 App JWT (GitHub allows at most 10 minutes; iat is backdated for clock drift).
 * @param {{ appId: string, privateKey: string, now?: number }} input now = epoch seconds
 */
export function createAppJwt({ appId, privateKey, now = Math.floor(Date.now() / 1000) }) {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(unsigned)
    .sign(normalizePrivateKey(privateKey))
    .toString('base64url');
  return `${unsigned}.${signature}`;
}

/**
 * Mint an installation access token. The token is scoped to the listed repositories (one or
 * several in the same owner/installation): the DKR, the dotfiles CLI repo and the product repo
 * are all reachable with a single token when listed together.
 * @param {{ appId: string, privateKey: string, repo?: string | null, repos?: string[] | null,
 *   installationId?: string | null,
 *   access?: 'read' | 'write', permissions?: Record<string, string> | null (overrides `access`; the broker maps its own scopes to these), apiUrl?: string, fetchImpl?: typeof fetch, now?: number }} input
 * @returns {Promise<{ token: string, expiresAt: string }>}
 */
export async function mintAppInstallationToken(input) {
  const {
    appId,
    privateKey,
    repo = null,
    repos = null,
    installationId = null,
    access = 'read',
    permissions = null,
    apiUrl = 'https://api.github.com',
    fetchImpl = fetch,
    now,
  } = input;
  if (!appId || !privateKey) {
    throw new Error(`GitHub App credentials need ${APP_ENV.id} and ${APP_ENV.key}`);
  }
  const slugs = [...(repos ?? []), ...(repo ? [repo] : [])].filter((v, i, all) => v && all.indexOf(v) === i);
  const parsed = slugs.map((slug) => {
    const hit = /^([\w.-]+)\/([\w.-]+)$/.exec(slug);
    if (!hit) {
      throw new Error(`invalid repo "${slug}" (expected owner/name)`);
    }
    return { owner: hit[1], name: hit[2], slug };
  });
  const owners = new Set(parsed.map((p) => p.owner.toLowerCase()));
  if (owners.size > 1) {
    throw new Error(`one installation token cannot span owners: ${slugs.join(', ')}`);
  }
  const m = parsed.length ? [null, parsed[0].owner, parsed[0].name] : null;
  const jwt = createAppJwt({ appId, privateKey, now });
  const base = apiUrl.replace(/\/+$/, '');
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${jwt}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'dotfiles-agent-env',
  };
  // Error bodies are GitHub's own message; they never echo the JWT or a token.
  const call = async (method, url, body) => {
    const res = await fetchImpl(url, {
      method,
      headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 200);
      try {
        message = JSON.parse(text).message ?? message;
      } catch {
        /* keep raw text */
      }
      throw new Error(`GitHub App API ${method} ${url.replace(base, '')} -> HTTP ${res.status}: ${message}`);
    }
    return JSON.parse(text);
  };

  let id = installationId;
  if (!id) {
    if (!m) {
      throw new Error(`cannot find the App installation: set ${APP_ENV.repo} (owner/name) or ${APP_ENV.installation}`);
    }
    try {
      id = String((await call('GET', `${base}/repos/${m[1]}/${m[2]}/installation`)).id);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      throw new Error(
        /HTTP 404/.test(text)
          ? `the GitHub App is not installed on ${m[1]}/${m[2]} (or the App id does not match): install it on every repo the agent must read (${slugs.join(', ')}). ${text}`
          : text,
      );
    }
  }
  const body = { permissions: permissions ?? appPermissions(access), ...(m ? { repositories: parsed.map((p) => p.name) } : {}) };
  let minted;
  try {
    minted = await call('POST', `${base}/app/installations/${encodeURIComponent(id)}/access_tokens`, body);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    throw new Error(
      /HTTP 422/.test(text) && parsed.length > 1
        ? `the App installation does not cover all of: ${slugs.join(', ')}. Add the missing repo(s) to the App installation. ${text}`
        : text,
    );
  }
  if (!minted.token) {
    throw new Error('GitHub App API returned no token');
  }
  return { token: minted.token, expiresAt: minted.expires_at };
}

const MINT_CHILD_SOURCE = `
import { pathToFileURL } from 'node:url';
const input = JSON.parse(process.env.${APP_MINT_INPUT_ENV});
const mod = await import(pathToFileURL(input.moduleFile).href);
try {
  process.stdout.write(JSON.stringify(await mod.mintAppInstallationToken(input)));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
`;

/**
 * Synchronous mint (callers resolve a token inline). Runs the async mint in a child Node process
 * with the key passed through its environment, never argv.
 * @param {Parameters<typeof mintAppInstallationToken>[0]} input
 * @returns {{ token: string, expiresAt: string }}
 */
export function mintAppInstallationTokenSync(input) {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', MINT_CHILD_SOURCE],
    {
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        [APP_MINT_INPUT_ENV]: JSON.stringify({ ...input, moduleFile: fileURLToPath(import.meta.url) }),
      },
    },
  );
  if (result.status !== 0) {
    const detail = (result.stderr || result.error?.message || 'mint failed').trim();
    throw new Error(detail.replaceAll(String(input.privateKey), '***'));
  }
  return JSON.parse(result.stdout);
}

/**
 * Installation token from App credentials in `env`, or null when none are configured. Cached
 * until shortly before expiry. Throws when credentials are present but minting fails.
 * @param {NodeJS.ProcessEnv} env
 * @param {{ repo?: string | null, repos?: string[] | null, access?: 'read' | 'write', permissions?: Record<string, string> | null, mint?: typeof mintAppInstallationTokenSync, now?: number }} [options]
 * @returns {{ token: string, expiresAt: string, cached: boolean } | null}
 */
export function resolveAppToken(env = process.env, options = {}) {
  const creds = appCredentialState(env);
  if (creds.state === 'none') {
    return null;
  }
  if (creds.state === 'partial') {
    throw new Error(`GitHub App credentials incomplete: missing ${creds.missing.join(', ')}`);
  }
  const access = options.access ?? 'read';
  const repos = options.repos?.length ? [...options.repos] : null;
  const repo = repos ? null : options.repo || envValue(env, APP_ENV.repo) || null;
  const installationId = envValue(env, APP_ENV.installation) || null;
  const permissions = options.permissions ?? null;
  const cacheKey = [envValue(env, APP_ENV.id), repo, (repos ?? []).join(','), installationId, access, JSON.stringify(permissions)].join('|');
  const nowMs = options.now ?? Date.now();
  const hit = appTokenCache.get(cacheKey);
  if (hit && Date.parse(hit.expiresAt) - APP_REFRESH_SKEW_MS > nowMs) {
    return { ...hit, cached: true };
  }
  const mint = options.mint ?? mintAppInstallationTokenSync;
  const minted = mint({
    appId: envValue(env, APP_ENV.id),
    privateKey: envValue(env, APP_ENV.key),
    repo,
    repos,
    installationId,
    access,
    permissions,
    apiUrl: envValue(env, APP_ENV.api) || undefined,
  });
  appTokenCache.set(cacheKey, minted);
  return { ...minted, cached: false };
}

/** Test seam: forget minted tokens. */
export function clearAppTokenCache() {
  appTokenCache.clear();
}

/**
 * Credential for private GitHub HTTPS (clone/fetch/push) when the agent platform's own install
 * token is scoped to the product repo only. The same credential serves every private repo the
 * agent must read: the DKR, the dotfiles CLI repo and the product repo. A GitHub App installation
 * token (minted from DKR_APP_ID + DKR_APP_PRIVATE_KEY) wins; if minting fails the static secrets
 * below are tried and the failure is reported on stderr, so a misconfigured App cannot silently
 * break a working PAT.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ repo?: string | null, repos?: string[] | null, access?: 'read' | 'write', mint?: typeof mintAppInstallationTokenSync }} [options]
 * @returns {{ token: string, source: string } | null} `source` is a name, never a value
 */
export function resolveGithubAuth(env = process.env, options = {}) {
  try {
    const app = resolveAppToken(env, options);
    if (app) {
      return { token: app.token, source: APP_ENV.id };
    }
  } catch (error) {
    console.error(
      `github-auth: GitHub App token unavailable (${error instanceof Error ? error.message : String(error)}); falling back to static token`,
    );
  }
  for (const key of ['GH_CLAUDE_SECRET', 'DKR_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    const value = env[key];
    if (typeof value === 'string' && value.trim()) {
      return { token: value.trim(), source: key };
    }
  }
  return null;
}

/**
 * Token-only form of {@link resolveGithubAuth} (kept for existing callers).
 * @param {NodeJS.ProcessEnv} [env]
 * @param {Parameters<typeof resolveGithubAuth>[1]} [options]
 * @returns {string | null}
 */
export function resolveDkrAuthToken(env = process.env, options = {}) {
  return resolveGithubAuth(env, options)?.token ?? null;
}

/**
 * Ephemeral git config so HTTPS calls to github.com use the token without writing
 * it into `.git/config` or `.gitmodules`.
 * @param {string | null | undefined} token
 * @returns {Record<string, string>}
 */
export function githubAuthGitEnv(token) {
  if (!token) {
    return {};
  }
  const b64 = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${b64}`,
  };
}

/**
 * @param {string[]} args
 * @param {{ cwd: string, env?: Record<string, string>, allowFail?: boolean }} options
 * @returns {{ ok: boolean, stdout: string, stderr: string }}
 */
export function git(args, options) {
  const result = spawnSync('git', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env ?? {}) },
  });
  const out = {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
  if (!out.ok && !options.allowFail) {
    throw new Error(`git ${args.join(' ')} failed in ${options.cwd}: ${out.stderr || out.stdout}`);
  }
  return out;
}

/**
 * Parse a git remote URL (https, ssh, scp-like, or local path) into host/owner/name.
 * @param {string | null | undefined} url
 * @returns {{ host: string | null, owner: string | null, name: string, full: string } | null}
 */
export function parseRemote(url) {
  if (!url) {
    return null;
  }
  const trimmed = url.trim().replace(/\/+$/, '');
  let host = null;
  let pathname = trimmed;
  const scp = trimmed.match(/^[^@/]+@([^:/]+):(.+)$/);
  const withScheme = trimmed.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i);
  if (trimmed.startsWith('file://')) {
    pathname = trimmed.slice('file://'.length);
  } else if (withScheme) {
    host = withScheme[1];
    pathname = withScheme[2];
  } else if (scp) {
    host = scp[1];
    pathname = scp[2];
  }
  const parts = pathname
    .replace(/\.git$/, '')
    .split(/[\\/]/)
    .filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  const name = parts[parts.length - 1];
  const owner = parts.length > 1 ? parts[parts.length - 2] : null;
  return { host, owner, name, full: owner ? `${owner}/${name}` : name };
}

/**
 * @param {string | null} branch
 * @param {{ pattern?: string, protected?: string[] }} [rules]
 * @returns {{ ok: boolean, reason: string }}
 */
export function checkBranch(branch, rules = {}) {
  const pattern = rules.pattern ?? DEFAULT_BRANCH_PATTERN;
  const protectedNames = rules.protected ?? DEFAULT_PROTECTED;
  if (!branch || branch === 'HEAD') {
    return { ok: false, reason: 'detached HEAD; check out a topic branch first' };
  }
  if (protectedNames.includes(branch)) {
    return { ok: false, reason: `"${branch}" is protected; paired pushes go to topic branches` };
  }
  if (!new RegExp(pattern).test(branch)) {
    return { ok: false, reason: `"${branch}" does not match ${pattern}` };
  }
  return { ok: true, reason: `"${branch}" matches ${pattern}` };
}

/**
 * @param {{ host: string | null, full: string }} remote
 * @param {string} base
 * @param {string} branch
 * @param {string} body
 * @returns {string | null}
 */
export function compareUrl(remote, base, branch, body) {
  if (!remote || remote.host !== 'github.com' || !remote.full.includes('/')) {
    return null;
  }
  const query = new URLSearchParams({ expand: '1', body }).toString();
  return `https://github.com/${remote.full}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?${query}`;
}

/**
 * Cross-reference text for companion PRs. GitHub autolinks `owner/repo#N` across repositories;
 * before a PR exists the reference is `owner/repo@branch` plus a prefilled compare URL.
 * @param {{
 *   branch: string,
 *   product: { host: string | null, full: string, base: string, pr?: number | null },
 *   dkr: { host: string | null, full: string, base: string, pr?: number | null, sha?: string | null },
 * }} input
 */
export function formatCrossLinks(input) {
  const { branch, product, dkr } = input;
  const ref = (side) => (side.pr ? `${side.full}#${side.pr}` : `${side.full}@${branch}`);
  const productBody = `Companion DKR PR: ${ref(dkr)}\nPaired-Branch: ${branch}${dkr.sha ? `\nPaired-DKR: ${dkr.full}@${dkr.sha}` : ''}`;
  const dkrBody = `Companion product PR: ${ref(product)}\nPaired-Branch: ${branch}`;
  return {
    productBody,
    dkrBody,
    productOpenUrl: product.pr ? null : compareUrl(product, product.base, branch, productBody),
    dkrOpenUrl: dkr.pr ? null : compareUrl(dkr, dkr.base, branch, dkrBody),
  };
}

/**
 * @param {string} root product repo root
 */
export function readPairedConfig(root) {
  const file = path.join(root, '.dkr', 'config.json');
  if (!fs.existsSync(file)) {
    throw new Error('Missing .dkr/config.json. Run: dotfiles install-dkr');
  }
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!config.paired || typeof config.paired.path !== 'string') {
    throw new Error('.dkr/config.json has no "paired" section. Run: dotfiles install-dkr');
  }
  return config.paired;
}

function defaultBranch(cwd, fallback) {
  const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
    cwd,
    allowFail: true,
  });
  return head.ok && head.stdout ? head.stdout.replace(/^origin\//, '') : fallback;
}

function findPrNumber(repoFull, branch) {
  // REST (gh api), not gh pr view: GraphQL is blocked in some environments where REST works.
  const owner = String(repoFull).split('/')[0];
  const probe = spawnSync(
    'gh',
    [
      'api',
      '--method',
      'GET',
      `repos/${repoFull}/pulls`,
      '-f',
      `head=${owner}:${branch}`,
      '-f',
      'state=open',
      '--jq',
      '.[0].number // empty',
    ],
    {
      encoding: 'utf8',
    },
  );
  if (probe.error || probe.status !== 0) {
    return null;
  }
  const n = Number.parseInt((probe.stdout ?? '').trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function hasStaged(cwd) {
  return !git(['diff', '--cached', '--quiet'], { cwd, allowFail: true }).ok;
}

function commitWithMessage(cwd, message) {
  git(['commit', '--quiet', '-m', message], { cwd });
}

/**
 * True when HEAD has commits the remote branch lacks. With no remote branch yet, push only when no
 * origin ref already contains HEAD (so an untouched DKR checkout does not open an empty branch).
 * @param {string} cwd
 * @param {string} branch
 * @param {{ skipWhenPublished?: boolean }} [options]
 */
function aheadOfRemote(cwd, branch, options = {}) {
  const remote = git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], {
    cwd,
    allowFail: true,
  });
  if (remote.ok) {
    return Number(git(['rev-list', '--count', `origin/${branch}..HEAD`], { cwd }).stdout) > 0;
  }
  if (options.skipWhenPublished) {
    return (
      git(['for-each-ref', '--contains', 'HEAD', '--format=%(refname)', 'refs/remotes/origin'], {
        cwd,
      }).stdout.length === 0
    );
  }
  return true;
}

/**
 * Put the DKR checkout on the same branch name as the product repo, carrying local edits.
 * @param {string} dkrDir
 * @param {string} branch
 * @param {(line: string) => void} log
 * @param {Record<string, string>} [authEnv]
 */
function alignDkrBranch(dkrDir, branch, log, authEnv = {}) {
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dkrDir }).stdout;
  if (current === branch) {
    return;
  }
  git(['fetch', '--quiet', 'origin', branch], { cwd: dkrDir, allowFail: true, env: authEnv });
  const local = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
    cwd: dkrDir,
    allowFail: true,
  });
  const remote = git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], {
    cwd: dkrDir,
    allowFail: true,
  });
  if (local.ok) {
    git(['switch', '--quiet', branch], { cwd: dkrDir });
  } else if (remote.ok) {
    git(['switch', '--quiet', '-c', branch, '--track', `origin/${branch}`], { cwd: dkrDir });
  } else {
    git(['switch', '--quiet', '-c', branch], { cwd: dkrDir });
  }
  log(`dkr: on branch ${branch} (was ${current})`);
}

/**
 * Keep the recorded `dkr` pointer unless its commit is no longer on any DKR remote ref; only then
 * move the checkout to the DKR base branch tip so the product pointer names a published commit.
 * @param {{ root: string, dkrDir: string, paired: Record<string, any>, log: (line: string) => void }} input
 * @returns {{ repointed: boolean, from: string | null, to: string | null }}
 */
export function repointIfNeeded({ root, dkrDir, paired, log, authEnv = {} }) {
  git(['fetch', '--quiet', '--prune', 'origin'], { cwd: dkrDir, env: authEnv });
  const entry = git(['ls-tree', 'HEAD', '--', paired.path], { cwd: root, allowFail: true }).stdout;
  const recorded = entry.match(/^160000 commit ([0-9a-f]{40})\t/)?.[1] ?? null;
  if (recorded) {
    const holders = git(
      ['for-each-ref', '--contains', recorded, '--format=%(refname:short)', 'refs/remotes/origin'],
      { cwd: dkrDir, allowFail: true },
    )
      .stdout.split('\n')
      .filter((ref) => ref && ref !== 'origin' && !ref.endsWith('/HEAD'));
    if (holders.length > 0) {
      log(`repoint: not needed; ${recorded.slice(0, 12)} is on ${holders[0]}`);
      return { repointed: false, from: recorded, to: recorded };
    }
  }
  if (git(['status', '--porcelain'], { cwd: dkrDir }).stdout) {
    throw new Error(`repoint: ${paired.path}/ has uncommitted changes; push or discard them first`);
  }
  const base = `origin/${paired.ref ?? 'main'}`;
  git(['checkout', '--quiet', '--detach', base], { cwd: dkrDir });
  const to = git(['rev-parse', 'HEAD'], { cwd: dkrDir }).stdout;
  log(
    `repoint: ${recorded ? recorded.slice(0, 12) : '(none)'} is not on the DKR remote; now ${base} ${to.slice(0, 12)}`,
  );
  return { repointed: true, from: recorded, to };
}

/** Commit the `relPath` gitlink names in `rev`, or null. */
function gitlinkOf(cwd, rev, relPath) {
  const entry = git(['ls-tree', rev, '--', relPath], { cwd, allowFail: true }).stdout;
  return entry.match(/^160000 commit ([0-9a-f]{40})\t/)?.[1] ?? null;
}

function hasCommit(cwd, sha) {
  return git(['cat-file', '-e', `${sha}^{commit}`], { cwd, allowFail: true }).ok;
}

function isAncestor(cwd, ancestor, descendant) {
  return git(['merge-base', '--is-ancestor', ancestor, descendant], { cwd, allowFail: true }).ok;
}

function unmergedFiles(cwd) {
  return git(['diff', '--name-only', '--diff-filter=U'], { cwd, allowFail: true })
    .stdout.split('\n')
    .filter(Boolean);
}

/**
 * Will merging `base` into this branch conflict on the `dkr` pointer? (PDE-DOTFILES-PAIRED-UC-008)
 * A pointer conflict happens only when both sides moved it to different commits. Git then
 * fast-forwards the pointer by itself when the branch's commit contains the base's, so the
 * branch is mergeable exactly when that holds. Reports instead of throwing; never blocks on what
 * it cannot see (no base ref, DKR objects missing), which comes back as `applies: false`.
 * @param {{ root: string, paired: Record<string, any>, base?: string }} input
 * @returns {{ ok: boolean, applies: boolean, name: string, detail: string }}
 */
export function evaluatePointerMergeable({ root, paired, base = 'origin/main' }) {
  const name = 'dkr/pointer-mergeable';
  const skip = (detail) => ({ ok: true, applies: false, name, detail });
  const dkrDir = path.join(root, paired.path);
  const mergeBase = git(['merge-base', base, 'HEAD'], { cwd: root, allowFail: true }).stdout;
  if (!mergeBase) return skip(`WARN no merge base with ${base}; not checked`);
  const atBase = gitlinkOf(root, mergeBase, paired.path);
  const onBase = gitlinkOf(root, base, paired.path);
  const onBranch = gitlinkOf(root, 'HEAD', paired.path);
  if (!onBase || !onBranch) return skip('no dkr pointer on one side; not checked');
  if (onBase === atBase) return skip(`${base} has not moved the pointer since this branch started`);
  if (onBranch === atBase) return skip('this branch has not moved the pointer');
  if (onBase === onBranch) return { ok: true, applies: true, name, detail: 'both sides point at the same DKR commit' };
  if (!hasCommit(dkrDir, onBase) || !hasCommit(dkrDir, onBranch)) {
    return skip(`WARN ${paired.path}/ lacks ${onBase.slice(0, 12)} or ${onBranch.slice(0, 12)}; not checked (fetch the DKR)`);
  }
  if (isAncestor(dkrDir, onBase, onBranch)) {
    return {
      ok: true,
      applies: true,
      name,
      detail: `branch pointer ${onBranch.slice(0, 12)} contains ${base}'s ${onBase.slice(0, 12)}; git fast-forwards it`,
    };
  }
  return {
    ok: false,
    applies: true,
    name,
    detail:
      `${base} moved the pointer to ${onBase.slice(0, 12)} and this branch's ${onBranch.slice(0, 12)} does not contain it, ` +
      'so merging will conflict on the dkr pointer; run: node .dkr/bin/paired-push.mjs --sync',
  };
}

/**
 * Bring the branch up to date with both bases so the pointer merges cleanly (PDE-DOTFILES-PAIRED-UC-008):
 * merge the DKR base into the DKR branch (so it contains the base's pointer), then merge the product
 * base, taking the DKR checkout's commit as the pointer if git still reports a pointer conflict.
 * Local only: commits nothing but merges; run `paired-push -m` afterwards to catch up and push. A real
 * content conflict (in the DKR or the product) is left in place for you to resolve and the error
 * names the files. Re-running after resolving continues where it stopped.
 * @param {{ root: string, paired: Record<string, any>, dryRun?: boolean, log: (line: string) => void,
 *   authEnv?: Record<string, string> }} input
 * @returns {{ dkrMerged: boolean, productMerged: boolean }}
 */
export function syncWithBase({ root, paired, dryRun = false, log, authEnv = {} }) {
  const dkrDir = path.join(root, paired.path);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root }).stdout;
  const verdict = checkBranch(branch, paired.branch ?? {});
  if (!verdict.ok) throw new Error(`branch check failed: ${verdict.reason}`);
  for (const [label, cwd] of [['product', root], [paired.path, dkrDir]]) {
    if (git(['rev-parse', '--git-dir'], { cwd, allowFail: true }).ok === false) {
      throw new Error(`${label} is not a git checkout`);
    }
    // The pointer itself is expected to differ from the checkout while resuming after a DKR merge.
    const pathspec = cwd === root ? ['--', '.', `:(exclude)${paired.path}`] : [];
    if (git(['status', '--porcelain', '--untracked-files=no', ...pathspec], { cwd }).stdout) {
      throw new Error(`${label} has uncommitted changes; commit them first (paired-push -m "<summary>")`);
    }
  }
  const productBase = `origin/${defaultBranch(root, 'main')}`;
  const dkrBase = `origin/${paired.ref ?? 'main'}`;
  git(['fetch', '--quiet', 'origin', productBase.replace(/^origin\//, '')], { cwd: root, allowFail: true, env: authEnv });
  git(['fetch', '--quiet', '--prune', 'origin'], { cwd: dkrDir, allowFail: true, env: authEnv });
  if (dryRun) {
    const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dkrDir }).stdout;
    if (current !== branch) log(`dry-run: would switch ${paired.path}/ from ${current} to ${branch}`);
  } else {
    alignDkrBranch(dkrDir, branch, log, authEnv);
  }

  /** @param {string} cwd @param {string} rev */
  const contains = (cwd, rev) => isAncestor(cwd, rev, 'HEAD');
  const result = { dkrMerged: false, productMerged: false };

  // 1. DKR: contain the DKR base, and whatever pointer the product base names.
  const wanted = [dkrBase];
  const basePointer = gitlinkOf(root, productBase, paired.path);
  if (basePointer && hasCommit(dkrDir, basePointer)) wanted.push(basePointer);
  for (const rev of wanted) {
    if (contains(dkrDir, rev)) continue;
    if (dryRun) {
      log(`dry-run: would merge ${rev.slice(0, 12)} into the DKR branch ${branch}`);
      result.dkrMerged = true;
      continue;
    }
    const merged = git(
      ['merge', '--no-edit', '-m', `Merge ${rev === dkrBase ? dkrBase : rev.slice(0, 12)} into ${branch}\n\nPaired-Branch: ${branch}`, rev],
      { cwd: dkrDir, allowFail: true },
    );
    if (!merged.ok) {
      const files = unmergedFiles(dkrDir);
      if (files.length === 0) {
        // Not a content conflict (for example no git identity): say what git said.
        throw new Error(`merging ${rev} into the DKR branch failed: ${merged.stderr || merged.stdout}`);
      }
      throw new Error(
        `merging ${rev} into the DKR branch conflicts in ${files.join(', ') || '(see git status)'}.\n` +
          `  Resolve them in ${paired.path}/ (git -C ${paired.path} add … && git -C ${paired.path} commit), then re-run --sync.`,
      );
    }
    log(`dkr: merged ${rev === dkrBase ? dkrBase : rev.slice(0, 12)} into ${branch}`);
    result.dkrMerged = true;
  }
  if (!result.dkrMerged) log(`dkr: already contains ${dkrBase}`);

  // 2. Product: merge the product base; the pointer fast-forwards or is taken from the DKR checkout.
  if (contains(root, productBase)) {
    log(`product: already contains ${productBase}`);
    return result;
  }
  if (dryRun) {
    log(`dry-run: would merge ${productBase} into ${branch}`);
    return { ...result, productMerged: true };
  }
  const dkrHead = git(['rev-parse', 'HEAD'], { cwd: dkrDir }).stdout;
  const merge = git(
    ['merge', '--no-edit', '--no-commit', '--no-ff', productBase],
    { cwd: root, allowFail: true },
  );
  if (!merge.ok) {
    const conflicts = unmergedFiles(root);
    const others = conflicts.filter((f) => f !== paired.path);
    if (others.length > 0) {
      throw new Error(
        `merging ${productBase} conflicts in ${others.join(', ')}.\n` +
          '  Resolve them (git add … && git commit), then run paired-push -m "<summary>".',
      );
    }
    if (conflicts.length === 0) {
      throw new Error(`merging ${productBase} failed: ${merge.stderr || merge.stdout}`);
    }
  }
  if (unmergedFiles(root).includes(paired.path) || gitlinkOf(root, 'HEAD', paired.path) !== dkrHead) {
    // The DKR checkout contains both sides (step 1), so it is the correct resolution.
    git(['update-index', '--add', '--cacheinfo', `160000,${dkrHead},${paired.path}`], { cwd: root });
  }
  commitWithMessage(
    root,
    `Merge ${productBase} into ${branch}\n\nPaired-Branch: ${branch}\nPaired-DKR: ${dkrHead}`,
  );
  log(`product: merged ${productBase} into ${branch} (${paired.path} -> ${dkrHead.slice(0, 12)})`);
  return { ...result, productMerged: true };
}

/**
 * @param {{
 *   cwd?: string,
 *   message?: string | null,
 *   dkrMessage?: string | null,
 *   dryRun?: boolean,
 *   linksOnly?: boolean,
 *   repoint?: boolean,
 *   sync?: boolean,
 *   log?: (line: string) => void,
 * }} options
 */
export function pairedPush(options = {}) {
  const log = options.log ?? ((line) => console.log(line));
  const root = git(['rev-parse', '--show-toplevel'], { cwd: options.cwd ?? process.cwd() }).stdout;
  const paired = readPairedConfig(root);
  const dkrDir = path.join(root, paired.path);
  if (
    !fs.existsSync(dkrDir) ||
    !git(['rev-parse', '--git-dir'], { cwd: dkrDir, allowFail: true }).ok
  ) {
    throw new Error(`${paired.path}/ is not a DKR checkout. Run: dotfiles install-dkr`);
  }

  // 1. State verification
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root }).stdout;
  const verdict = checkBranch(branch, paired.branch ?? {});
  if (!verdict.ok) {
    throw new Error(`branch check failed: ${verdict.reason}`);
  }
  log(`branch: ${verdict.reason}`);

  if (options.sync) {
    const syncAuth = githubAuthGitEnv(
      resolveDkrAuthToken(process.env, { repo: paired.repo, access: 'write' }),
    );
    syncWithBase({ root, paired, dryRun: options.dryRun, log, authEnv: syncAuth });
    log('next: node .dkr/bin/paired-push.mjs -m "<summary>"   (catch up the twin marker and push)');
    return { branch, links: null, repointed: false };
  }

  const productRemote = parseRemote(
    git(['remote', 'get-url', 'origin'], { cwd: root, allowFail: true }).stdout,
  );
  const dkrRemote = parseRemote(
    git(['remote', 'get-url', 'origin'], { cwd: dkrDir, allowFail: true }).stdout,
  );
  if (!productRemote || !dkrRemote) {
    throw new Error('both the product repo and the DKR checkout need an "origin" remote');
  }
  // paired-push opens/pushes DKR branches, so it asks the App for write access.
  const authEnv = githubAuthGitEnv(
    resolveDkrAuthToken(process.env, { repo: paired.repo, access: 'write' }),
  );
  const pushEnv = { ...authEnv, [PAIRED_PUSH_ENV]: '1' };
  if (Object.keys(authEnv).length > 0) {
    log('dkr: using GitHub App token / GH_CLAUDE_SECRET / DKR_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN for HTTPS auth (not written to git config)');
  }

  // Repoint only when the recorded pointer is gone from the DKR remote (DKR PRs merge with a
  // merge commit, so a merged feature-branch commit stays reachable and needs no repoint).
  if (options.repoint) {
    const result = repointIfNeeded({ root, dkrDir, paired, log, authEnv });
    if (!result.repointed) {
      return { branch, links: null, repointed: false };
    }
  }

  if (!options.linksOnly) {
    const dkrDirty = git(['status', '--porcelain'], { cwd: dkrDir }).stdout.length > 0;
    const productDirty = git(['status', '--porcelain'], { cwd: root }).stdout.length > 0;
    if (options.repoint && !options.message) {
      options = { ...options, message: `Repoint ${paired.path} to ${paired.ref ?? 'main'}` };
    }
    if ((dkrDirty || productDirty) && !options.message) {
      throw new Error('uncommitted changes need a message: paired-push -m "<summary>"');
    }
    if (options.dryRun) {
      log(
        `dry-run: dkr ${dkrDirty ? 'has' : 'has no'} changes; product ${productDirty ? 'has' : 'has no'} changes`,
      );
      if (!options.repoint && productDirty) {
        log('dry-run: would commit product work before catch-up so the marker covers that HEAD');
      }
      if (!options.repoint) {
        runCatchUpBeforePush({
          root,
          dkrDir,
          log,
          dryRun: true,
        });
      }
      log(`dry-run: would push ${dkrRemote.full}@${branch} then ${productRemote.full}@${branch}`);
    } else {
      // 2a. Product work first (when dirty), then catch-up, then DKR marker, then metadata.
      // Catch-up covers product HEAD; if we committed after catch-up, that commit would be stale.
      if (!options.repoint) {
        alignDkrBranch(dkrDir, branch, log, authEnv);

        if (productDirty) {
          // Leave the dkr gitlink for the post-marker metadata commit.
          git(['add', '-A'], { cwd: root });
          git(['reset', '--', paired.path], { cwd: root, allowFail: true });
          if (hasStaged(root)) {
            commitWithMessage(
              root,
              `${options.message}\n\nPaired-Branch: ${branch}`,
            );
            log(
              `product: committed work ${git(['rev-parse', '--short', 'HEAD'], { cwd: root }).stdout} (before catch-up)`,
            );
          }
        }

        runCatchUpBeforePush({
          root,
          dkrDir,
          log,
          dryRun: false,
        });

        if (git(['status', '--porcelain'], { cwd: dkrDir }).stdout.length > 0) {
          git(['add', '-A'], { cwd: dkrDir });
        }
        if (hasStaged(dkrDir)) {
          const summary = options.dkrMessage ?? `${options.message} (DKR)`;
          commitWithMessage(
            dkrDir,
            `${summary}\n\nPaired-Branch: ${branch}\nPaired-Product: ${productRemote.full}`,
          );
          log(`dkr: committed ${git(['rev-parse', '--short', 'HEAD'], { cwd: dkrDir }).stdout}`);
        }
        if (aheadOfRemote(dkrDir, branch, { skipWhenPublished: true })) {
          git(['push', '--quiet', '-u', 'origin', branch], { cwd: dkrDir, env: pushEnv });
          log(`dkr: pushed ${dkrRemote.full}@${branch}`);
        } else {
          log('dkr: nothing to push');
        }
      }

      // 2b. Product metadata: pin intent to the DKR tip that holds the marker + stage gitlink.
      const dkrSha = git(['rev-parse', 'HEAD'], { cwd: dkrDir }).stdout;
      const intentDir = path.join(root, '.dkr', 'intents');
      const intentCandidates = [
        path.join(intentDir, `${branch.replace(/\//g, '--')}.json`),
        path.join(root, '.dkr', 'intent.json'),
      ];
      for (const intentFile of intentCandidates) {
        if (!fs.existsSync(intentFile)) {
          continue;
        }
        try {
          const intent = JSON.parse(fs.readFileSync(intentFile, 'utf8'));
          if (
            intent &&
            (intent.mode === 'amend' || intent.mode === 'declare-done') &&
            typeof intent.dkr_sha === 'string' &&
            intent.dkr_sha !== dkrSha
          ) {
            intent.dkr_sha = dkrSha;
            fs.writeFileSync(intentFile, `${JSON.stringify(intent, null, 2)}\n`, 'utf8');
            log(`catch-up: pinned ${path.relative(root, intentFile)} dkr_sha → ${dkrSha.slice(0, 12)}`);
          }
        } catch {
          /* ignore unreadable intent */
        }
        break;
      }
      git(['add', '-A'], { cwd: root });
      git(['add', paired.path], { cwd: root });
      if (hasStaged(root)) {
        // After a normal push with prior product work, the second commit is just pointer/intent.
        // --repoint always keeps its dedicated subject even when the tree was dirty.
        const metaMessage =
          productDirty && !options.repoint
            ? `Paired-DKR pointer and twin intent after catch-up\n\nPaired-Branch: ${branch}\nPaired-DKR: ${dkrRemote.full}@${dkrSha}`
            : `${options.message}\n\nPaired-Branch: ${branch}\nPaired-DKR: ${dkrRemote.full}@${dkrSha}`;
        commitWithMessage(root, metaMessage);
        log(`product: committed ${git(['rev-parse', '--short', 'HEAD'], { cwd: root }).stdout}`);
      }

      // 3. Product: push to its own remote
      if (aheadOfRemote(root, branch)) {
        git(['push', '--quiet', '--recurse-submodules=check', '-u', 'origin', branch], {
          cwd: root,
          env: pushEnv,
        });
        log(`product: pushed ${productRemote.full}@${branch}`);
      } else {
        log('product: nothing to push');
      }
    }
  }

  // 4. Cross-linking
  const dkrSha = git(['rev-parse', 'HEAD'], { cwd: dkrDir }).stdout;
  const links = formatCrossLinks({
    branch,
    product: {
      ...productRemote,
      base: defaultBranch(root, 'main'),
      pr: productRemote.host === 'github.com' ? findPrNumber(productRemote.full, branch) : null,
    },
    dkr: {
      ...dkrRemote,
      base: paired.ref ?? defaultBranch(dkrDir, 'main'),
      pr: dkrRemote.host === 'github.com' ? findPrNumber(dkrRemote.full, branch) : null,
      sha: dkrSha,
    },
  });
  log('\n--- product PR body ---');
  log(links.productBody);
  if (links.productOpenUrl) {
    log(`open: ${links.productOpenUrl}`);
  }
  log('\n--- DKR PR body ---');
  log(links.dkrBody);
  if (links.dkrOpenUrl) {
    log(`open: ${links.dkrOpenUrl}`);
  }
  return { branch, links };
}

function printHelp() {
  console.log(`paired-push — commit and push a product repo and its DKR checkout together

Usage:
  node .dkr/bin/paired-push.mjs -m "<summary>" [--dkr-message "<summary>"] [--dry-run]
  node .dkr/bin/paired-push.mjs --links
  node .dkr/bin/paired-push.mjs --repoint   # only if the dkr pointer left the DKR remote
  node .dkr/bin/paired-push.mjs --sync [--dry-run]   # merge DKR main, then product main, so the dkr pointer merges cleanly
  node .dkr/bin/paired-push.mjs --mint-token --repos owner/a,owner/b   # print a read credential

Raw git push is blocked by the pre-push hook that dotfiles install-dkr installs.`);
}

function main(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    printHelp();
    return 0;
  }
  const value = (...names) => {
    for (const name of names) {
      const idx = argv.indexOf(name);
      if (idx !== -1) {
        return argv[idx + 1] ?? null;
      }
      const eq = argv.find((a) => a.startsWith(`${name}=`));
      if (eq) {
        return eq.slice(name.length + 1);
      }
    }
    return null;
  };
  if (argv.includes('--mint-token')) {
    // Used by .dkr/agent-env/bootstrap.sh before the dotfiles CLI exists: print one credential that can
    // read every listed repo (App installation token, else the first static secret). Token to
    // stdout only; the source *name* goes to stderr.
    const repos = (value('--repos') ?? '').split(',').map((r) => r.trim()).filter(Boolean);
    const access = value('--access') === 'write' ? 'write' : 'read';
    const auth = resolveGithubAuth(process.env, { repos, access });
    if (!auth) {
      console.error('paired-push: no GitHub credential: set DKR_APP_ID + DKR_APP_PRIVATE_KEY or GH_CLAUDE_SECRET');
      return 1;
    }
    console.error(`paired-push: credential from ${auth.source}${repos.length ? ` for ${repos.join(', ')}` : ''}`);
    process.stdout.write(`${auth.token}\n`);
    return 0;
  }
  try {
    pairedPush({
      message: value('-m', '--message'),
      dkrMessage: value('--dkr-message'),
      dryRun: argv.includes('--dry-run'),
      linksOnly: argv.includes('--links'),
      repoint: argv.includes('--repoint'),
      sync: argv.includes('--sync'),
    });
    return 0;
  } catch (error) {
    console.error(`paired-push: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const invoked = process.argv[1] ? pathToFileURL(fs.realpathSync(process.argv[1])).href : null;
if (invoked && invoked === pathToFileURL(fs.realpathSync(fileURLToPath(import.meta.url))).href) {
  process.exit(main(process.argv.slice(2)));
}
