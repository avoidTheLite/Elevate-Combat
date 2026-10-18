<!-- dotfiles agent-env (generated) -->
# Agent secrets (names only, never values)

> Temporary working names (PDE-DOTFILES-PAIRED-DP-005); do not build tooling that depends on
> these exact names. Prefer the GitHub App pair: installation tokens are minted at setup time and
> expire in an hour, so there is no 90-day PAT rotation. `GH_CLAUDE_SECRET` is the fallback.

- `DKR_APP_ID` (optional): GitHub App id (preferred). The App must be installed on every private repo the agent reads: the product repo, the DKR, and the dotfiles CLI repo. One short-lived token covering all of them is minted at setup time, so nothing expires on a schedule.
- `DKR_APP_PRIVATE_KEY` (optional): The App private key (PEM, PEM with literal \n, or base64 of the PEM). Always paired with DKR_APP_ID. Optional: DKR_APP_INSTALLATION_ID.
- `GH_CLAUDE_SECRET` (optional): Fallback when no GitHub App is configured: a PAT with read access (Contents: read) to every private repo the agent clones: the dotfiles CLI repo and the DKR (and the product repo if the platform does not already provide it). The same value is used for all of them. Write + Pull requests only for agents that open twin PRs.
- `DKR_BROKER_URL` (optional): Base URL of the agent broker (https; agent-broker/v1). Non-secret. Target path once the runner serves the broker; see guides/agent-environment/broker.md.
- `DKR_BROKER_GRANT` (optional): Per-environment, short-lived caller grant for the broker (a bearer credential: treat as a secret). Issued by the operator with `dotfiles broker grant`; never contains the App key.

| Secret | Platform | Where to add it |
| --- | --- | --- |
| `DKR_APP_ID` | copilot | Repo Settings > Environments > copilot > Environment secrets |
| `DKR_APP_ID` | cursor | Cursor Dashboard > Cloud Agents > Secrets |
| `DKR_APP_ID` | claude | Claude Code on the web > environment settings > environment variables |
| `DKR_APP_ID` | codex | Codex environment > Secrets (available to the setup script only) |
| `DKR_APP_PRIVATE_KEY` | copilot | Repo Settings > Environments > copilot > Environment secrets |
| `DKR_APP_PRIVATE_KEY` | cursor | Cursor Dashboard > Cloud Agents > Secrets |
| `DKR_APP_PRIVATE_KEY` | claude | Claude Code on the web > environment settings > environment variables |
| `DKR_APP_PRIVATE_KEY` | codex | Codex environment > Secrets (available to the setup script only) |
| `GH_CLAUDE_SECRET` | copilot | Repo Settings > Environments > copilot > Environment secrets |
| `GH_CLAUDE_SECRET` | cursor | Cursor Dashboard > Cloud Agents > Secrets |
| `GH_CLAUDE_SECRET` | claude | Claude Code on the web > environment settings > environment variables |
| `GH_CLAUDE_SECRET` | codex | Codex environment > Secrets (available to the setup script only) |
| `DKR_BROKER_URL` | copilot | Repo Settings > Environments > copilot > Environment variables |
| `DKR_BROKER_URL` | cursor | Cursor Dashboard > Cloud Agents > Environment variables |
| `DKR_BROKER_URL` | claude | Claude Code on the web > environment settings > environment variables |
| `DKR_BROKER_URL` | codex | Codex environment > Environment variables |
| `DKR_BROKER_GRANT` | copilot | Repo Settings > Environments > copilot > Environment secrets |
| `DKR_BROKER_GRANT` | cursor | Cursor Dashboard > Cloud Agents > Secrets |
| `DKR_BROKER_GRANT` | claude | Claude Code on the web > environment settings > environment variables |
| `DKR_BROKER_GRANT` | codex | Codex environment > Secrets (setup script only; NOT VERIFIED to reach the agent phase) |

New repo checklist:

1. Grant the token / GitHub App access to this repo and to the DKR repo.
2. Run `dotfiles agent-env init` in this repo and merge it to the default branch.
3. Confirm each platform has the secret above, then run `dotfiles agent-env doctor` in that platform.

Doctor exit code: 0 ready, 1 not ready. `--json` for machines, `--offline` to skip the network check
(the agent phase of some platforms has no network; hydrate in setup).
