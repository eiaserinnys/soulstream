# Portable node connect

## Request path

A public shallow clone of `eiaserinnys/soulstream` is the only input. `portable-node/start.sh` (Windows: `portable-node/start.cmd` → `bootstrap.ps1`) reads `portable-node/runtime-lock.json`, downloads the pinned Node archive for the current platform, verifies its `sha256`, extracts it under `portable-node/.state/runtimes/node/<version>/<platform>`, copies `launcher.mjs`, `defaults.json`, and `lib/` to `.state/boot`, and starts the launcher with that Node. The launcher checks the lock again on every re-entry signal (exit code 75), so a new lock switches the Node runtime without touching the checkout's scripts.

On first run `lib/pairing.mjs` asks for `node_id` and `company_pc`, calls `POST /api/node-pair/start`, prints the user code, and polls `POST /api/node-pair/poll` until approval or `expires_at`. The approved token is written to `.state/node.json` and is never printed.

`lib/release.mjs` fetches `GET /api/node/releases/current` with the node bearer, compares `source_commit` with the checkout HEAD, and on a mismatch fetches only that SHA and detaches the checkout while `.state/` stays ignored. It then downloads the pinned runtime archives, `GET /api/node/bootstrap`, and the payload. The bundle is checked against its `sha256`, inspected before extraction for absolute paths, `..`, symlinks, and hard links (runtime archives allow relative links that resolve inside their own folder), extracted to a temporary directory, bound with `bind-release.mjs`, and moved to `.state/releases/<source_commit>`.

`lib/config.mjs` writes the config generation (with the state-root placeholder resolved) under `.state/config/<generation>` and builds the child environment file. `lib/git.mjs` writes the credential helper and `.state/git/gitconfig`, clones `seosoyoung_workspace` with `--depth 1 --filter=blob:none --no-checkout` plus the non-cone sparse patterns `/*` and `!/.local/artifacts/`, and clones `seosoyoung-common` shallow in full. Both remotes are the orchestrator proxy; the child gets `GIT_CONFIG_GLOBAL` pointing at the state config.

Codex runs `codex login --device-auth` against `CODEX_HOME=.state/codex` with `cli_auth_credentials_store = "file"` when login is missing. Claude is not logged in by the launcher; the terminal points at the existing dashboard node login location. `lib/supervisor.mjs` starts `soul-server-ts` as the foreground child with the explicit environment contract from `lib/environment.mjs`.

## Version switch and supervision

Every `check_interval_secs` the launcher re-reads `current`. A new `source_commit` stages the payload and runtimes first, then holds the switch while the source worktree is dirty. A clean worktree fetches the new SHA, checks it out detached, activates the new config generation and bound release, and re-enters the shim, which starts the new launcher under the new lock. The previous child stays up until activation succeeds; one failed new start rolls back once to the last verified release.

Unexpected child exits restart the same release after `restart_delay_ms`; Ctrl+C and terminal termination are forwarded and never restart. Workspace and common fetch and fast-forward on every start; local changes are preserved and the failure is reported while the existing checkout still starts. There is no periodic workspace update.

## Failure and response

Pairing expiry prints the expiry and exits without re-pairing. A revoked credential (401) stops the launcher and does not re-pair. Payload hash mismatch, unsafe archive entries, checksum failure, or a failed bind leave the previous release running and are reported. Missing `Git` or unsupported platform/architecture fails in the bootstrap with an explicit message. No GitHub token, `GH_TOKEN`, `GITHUB_TOKEN`, service bearer, or `ANTHROPIC_API_KEY` is written to the child environment; the child's bearer is the node token.
