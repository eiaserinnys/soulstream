# Installation

This guide covers the Linux one-line installer (including updates, Tailscale Serve, and uninstalling), the Windows worker installer, and running the full Soulstream stack from source.

## Linux one-line installer

Run the installer as `root` on a fresh Debian 13 (`x86_64`) server. Recommended specs are at least 2 vCPU, 4 GB RAM, and 40 GB disk. The installer checks for at least 3.5 GiB RAM and 20 GB free space on `/`.

```bash
bash -c 'set -euo pipefail; (command -v curl >/dev/null 2>&1 && test -f /etc/ssl/certs/ca-certificates.crt) || (apt-get update && apt-get install -y curl ca-certificates); tmp=$(mktemp); trap "rm -f \"$tmp\"" EXIT; curl -fsSL https://raw.githubusercontent.com/eiaserinnys/soulstream/main/install/install.sh -o "$tmp"; bash "$tmp" --backends claude,codex'
```

`--backends` takes a comma-separated list of `claude`, `codex`, and `antigravity` (default: `claude,codex`). The first backend becomes the backend for the default `seosoyoung` and `seosoyoung-pas` profiles. Pin a revision with `--ref <ref>` for Soulstream or `--atom-ref <ref>` for atom (branch, tag, or commit).

On one server, the installer sets up:

- Soulstream (dashboard, orchestrator, and worker).
- atom, a knowledge tree for instructions and skills (`/home/soulstream/atom`, loopback port `4200`).
- Starter instructions and skills in atom.
- Default agent profiles `seosoyoung` and `seosoyoung-pas`.
- One default profile per selected backend (`claude-default`, `codex-default`, `antigravity-default`), plus `card-orchestrator` when you select `claude`.

The installer installs required packages, creates the `soulstream` user, sets up Node.js, the selected CLIs, and PostgreSQL, and clones Soulstream and atom. It builds and starts atom, issues an API key, loads starter instructions, then configures Soulstream, builds it, initializes the schema, and starts it under systemd. It creates the local workspace folder and checks service connectivity and authentication. The log is `/var/log/soulstream-install.log`.

Starter instructions load once, on a fresh install; reruns and updates never change existing atom instructions. Warnings under `Atom instructions:` mean:

- The atom tree already existed, so starter instructions were not loaded.
- A seed card changed after creation, so it was kept unchanged.
- A config-linked node (such as the skill catalog) was deleted in atom, so its link was left empty.
- An entry in `config/.atom-seed-map.json` was not a valid UUID (`atom seed map: ignored invalid value`), so it was ignored.

Before finishing, the installer refreshes model preset status (up to 6 attempts, 60 s per request, 10 s between retries). Installation continues even if refresh fails.

After installation, open **Settings > Coding agents** (`설정 > 코딩 에이전트`) in the dashboard to connect Claude, Codex, and Antigravity without server commands. The node's model presets refresh right away.

- **Claude** uses the account pool that the installer turns on, so zero accounts is valid. Expand the Claude row and choose Add account (`계정 추가`). While no pool store exists, the worker tries to import an existing `~/.claude/.credentials.json` at each startup and skips it if identity verification fails.
- **Codex** uses device-code login. Open the URL the dashboard shows and enter the one-time code. If the dashboard reports that device code authentication is off, turn it on in the security section of your ChatGPT settings and try again.
- **Antigravity** uses Google authentication. Open the URL the dashboard shows and paste the returned code into the dashboard.

If you cannot use the dashboard, sign in over SSH: run `sudo -Hu soulstream /usr/local/bin/codex login --device-auth` for Codex, or run `~/.local/bin/agy` as `soulstream` for Antigravity and exit with `/exit`. Presets update within five minutes after SSH login, and the finish output prints a manual refresh command. Claude has no SSH login flow.

Forward both ports over SSH to open the dashboard and atom locally:

```bash
ssh -L 127.0.0.1:5200:127.0.0.1:5200 -L 127.0.0.1:4200:127.0.0.1:4200 <user>@<server>
```

Open Soulstream at `http://127.0.0.1:5200` and atom at `http://127.0.0.1:4200` with the same administrator password. The installer never prints it; read it on the server with `sudo cat /home/soulstream/soulstream/.admin-password`. The atom button (`atom 열기`) in the dashboard toolbar also opens atom (`ATOM_PUBLIC_URL`) in a new tab.

In a new browser, the dashboard opens the persistent assistant session view (`/persistent`) by default; turn this off in **Settings > Appearance** (`설정 > 화면과 읽기`). The installer sets `PERSISTENT_SESSION_BOOTSTRAP=true`, so the dashboard creates one default persistent session (`seosoyoung-pas`) when you connect the first coding agent.

### Updating

Re-run the same one-line command to update. Without `--ref` or `--atom-ref`, both repositories move to the latest `origin/main`. Pass the same `--backends` value you installed with (omitting it defaults to `claude,codex`). An installation without atom also gains atom with the same command.

Before it stops any service, the installer checks both repositories. If it finds uncommitted changes, a non-git directory, an unresolvable revision, local commits not on `origin`, or a Soulstream revision predating atom support, it aborts without touching running services. Untracked installer files (config and `.env`) do not block updates.

Updates preserve secrets, both databases (`soulstream` and `atom`), the existing workspace, unmanaged `.env` lines, and edited config files. Edited managed files stay untouched; new defaults go beside them as `<file>.installer-new` and appear under `Configuration:` ([managed config files](configuration.md#files-the-linux-installer-manages)).

After the checks pass, the installer stops `soulstream-worker`, `soulstream-orch`, and `soulstream-atom`, then checks out, builds, migrates, and restarts them. The finish output shows previous and new revisions for both repositories. If a step fails after stopping services, all three stay stopped and `/home/soulstream/soulstream/.local/install-state.json` records the failed step and revisions; fix the cause and re-run to recover. Databases do not roll back automatically. Instead, the installer dumps `soulstream` before non-additive schema changes and any non-empty `atom` database before every migration to `/home/soulstream/soulstream/.local/backups/` (mode `0600`, latest 3 per database). Failure output and `install-state.json` (`backups`) list backup paths and restore commands. Restore only when discarding the new revision: keep services stopped, check out a compatible revision, and restore into an empty database from a `root` shell.

### Tailscale Serve

Add `--tailscale` to the install command for passwordless Soulstream access with an allowed Tailscale account. Enable MagicDNS and HTTPS in your tailnet. Approve any login URL within 10 minutes (already-connected devices skip approval).

```bash
bash install/install.sh --tailscale --tailscale-user owner@example.com
```

Personal devices default to their own account when you omit `--tailscale-user`; tagged devices require it. To use an auth key, store it in a file and pass `--tailscale-auth-key-file <path>` so it never enters process arguments. After installation, open the printed HTTPS URL from a tailnet device signed in as that account. Local processes on the server can forge identity headers, so run only trusted processes on the host.

atom is served on `:8443` of the same host (`https://<MagicDNS-name>:8443`) and still uses the administrator password in `/home/soulstream/soulstream/.admin-password` (read with `sudo cat`).

Re-run without `--tailscale` to return to password mode. To remove Serve access and disconnect the device, run `tailscale serve reset && tailscale logout`.

### Uninstalling

Run the uninstaller as `root` on the dedicated server where you installed Soulstream:

```bash
bash -c 'set -euo pipefail; tmp=$(mktemp); trap "rm -f \"$tmp\"" EXIT; curl -fsSL https://raw.githubusercontent.com/eiaserinnys/soulstream/main/install/uninstall.sh -o "$tmp"; bash "$tmp"'
```

For non-interactive runs, pass `--yes` inside the inner command:

```bash
bash -c 'set -euo pipefail; tmp=$(mktemp); trap "rm -f \"$tmp\"" EXIT; curl -fsSL https://raw.githubusercontent.com/eiaserinnys/soulstream/main/install/uninstall.sh -o "$tmp"; bash "$tmp" --yes'
```

Before changing anything, the uninstaller scans the server, prints what it found, and prompts once on `/dev/tty`. If no interactive terminal is available and you omit `--yes`, it exits without making changes. If you run the command again after a clean removal, it prints `Nothing to uninstall.` and exits `0`.

If you want a copy of your data before uninstalling, export both databases and archive the workspace outside `/home/soulstream`:

```bash
sudo -u postgres pg_dump -Fc soulstream > /root/soulstream.pgdump && sudo -u postgres pg_dump -Fc atom > /root/atom.pgdump && tar -czf /root/soulstream-workspace.tar.gz -C /home/soulstream workspace
```

Because the Linux installer targets a dedicated server, confirming deletes the Soulstream-named resources by name:

- `soulstream-worker.service`, `soulstream-orch.service`, and `soulstream-atom.service`, along with any remaining `soulstream` processes and the `soulstream` user's crontab.
- The `soulstream` and `atom` PostgreSQL databases (session history, folders, cards, pages, and atom documents), and the `soulstream` PostgreSQL role unless objects in another database depend on it.
- The `soulstream` system user and all of `/home/soulstream` (workspace files, git worktrees, automatic database backups under `/home/soulstream/soulstream/.local/backups`, the administrator password, user-scoped CLIs, and saved Claude, Codex, and Antigravity login credentials).
- The install log at `/var/log/soulstream-install.log`.

If Tailscale is installed, the uninstaller checks `tailscale serve status --json` and turns off the `/` routes on HTTPS ports `443` and `8443` only when they proxy to Soulstream (`http://127.0.0.1:5200`) and atom (`http://127.0.0.1:4200`), then checks Serve status again. It leaves other paths on those ports and all other ports untouched.

For global tools under `/usr/local`, the uninstaller removes `@openai/codex`, Corepack shims (`pnpm`, `pnpx`, `yarn`, `yarnpkg`), and Node.js only when `/etc/soulstream/install-receipt.json` records that the installer added them. It removes Node.js and the Corepack shims only if `/usr/local/bin/node --version` still matches the recorded version and no other global npm packages exist in `/usr/local/lib/node_modules`. Otherwise, it keeps those tools and lists them at the end. When every step succeeds, the uninstaller also removes `/etc/soulstream/install-receipt.json`.

The uninstaller keeps OS `apt` packages (such as `postgresql-17`, `git`, and `tmux`), tools that existed before installation or have no install receipt, and the Tailscale package and device login. If you also want to disconnect the server from your tailnet, run `tailscale logout`.

If any Soulstream service fails to stop, or if the script cannot confirm it stopped, it skips removing processes, databases, `/usr/local` tools, the `soulstream` user, and `/home/soulstream`, and reports the failure. If remaining `soulstream` processes do not exit, it skips removing the user and `/home/soulstream`. When a step fails, independent steps still run. At the end, the uninstaller lists the failed items, keeps `/etc/soulstream/install-receipt.json` (and `/usr/local/bin/node` if an earlier `/usr/local` removal failed), and exits with code `1`. Fix the underlying cause and run the command again to finish cleaning up.

## Requirements

- **Node.js**: 22.5 or newer (`>=22.5`).
- **pnpm**: `10.32.1` (managed via `corepack enable`).
- **PostgreSQL**: required by `orch-server-ts` for canonical persistence. Execution workers (`soul-server-ts`) do not connect to PostgreSQL.
- **Python**: 3.11 or newer (checked by the Windows worker installer).

## Windows worker installer

The PowerShell installer ([`install/install.ps1`](../../install/install.ps1)) registers a `soul-server-ts` worker on Windows with an existing remote `orch-server-ts` control plane. It does not install an orchestrator or run database migrations.

Before installing, the script verifies Python 3.11+ and Node.js 22.5+, installs the Claude Code CLI, [Haniel](https://github.com/eiaserinnys/haniel), and pnpm `10.32.1` if missing, generates `haniel.yaml` and `.env.soul-server-ts`, builds `soul-server-ts`, and starts the worker service.

Interactive install:

```powershell
irm https://raw.githubusercontent.com/eiaserinnys/soulstream/main/install/install.ps1 | iex
```

Non-interactive install:

```powershell
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/eiaserinnys/soulstream/main/install/install.ps1'))) `
  -NonInteractive `
  -UpstreamUrl $env:SOULSTREAM_UPSTREAM_URL `
  -AuthBearerToken $env:SOULSTREAM_AUTH_BEARER_TOKEN
```

Installer defaults and flags:

- Default install directory (`-InstallDir`): `%USERPROFILE%\soulstream`
- Default agent workspace (`-WorkspaceDir`): `%USERPROFILE%\workspace`
- Default worker port (`-Port`): `3105`
- Required in `-NonInteractive` mode: `-UpstreamUrl` (remote orchestrator WebSocket URL) and `-AuthBearerToken` (shared service token).
- Haniel auto-apply is disabled by default. It detects new commits and presents them for approval without silently pulling or restarting the service.

## Running from source

Run all workspace commands from the repository root.

1. Enable Corepack, install dependencies, and build the active TypeScript packages:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm --dir unified-dashboard build
pnpm --dir orch-server-ts build
pnpm --dir soul-server-ts build
```

2. Copy the example agent registry for the local worker:

```bash
cp soul-server-ts/config/agents.yaml.example soul-server-ts/config/agents.yaml
```

3. Create `.env.soul-server-ts` in the repository root for the worker:

```dotenv
SOULSTREAM_NODE_ID=local-worker
SOULSTREAM_UPSTREAM_URL=ws://127.0.0.1:5200/ws/node
EVENT_OUTBOX_DIR=.local/event-outbox
AGENTS_CONFIG_PATH=soul-server-ts/config/agents.yaml
MCP_ENABLED=true
MCP_PATH=/mcp
MCP_INTERNAL_PORT=4206
ENVIRONMENT=development
```

## Fresh database initialization

Initialize a fresh, empty PostgreSQL database once before starting `orch-server-ts`. The `fresh-install` command also verifies an already-current database and fails closed when an existing database requires pending migrations through the Haniel release path:

```bash
export DATABASE_URL=postgresql://user:password@127.0.0.1:5432/soulstream
node packages/db-schema/scripts/migrate.mjs fresh-install
```

Start the orchestrator (`CLAUDE_OAUTH_CLIENT_ID` must contain a valid OAuth application client ID, and `CLAUDE_OAUTH_CALLBACK_URL` must be registered with that application):

```bash
export CLAUDE_OAUTH_CLIENT_ID=your-client-id
export CLAUDE_OAUTH_CALLBACK_URL=http://127.0.0.1:5200/api/nodes/claude-auth/callback

ENVIRONMENT=development \
HOST=127.0.0.1 \
PORT=5200 \
DATABASE_URL="$DATABASE_URL" \
SOULSTREAM_PUBLIC_URL="http://127.0.0.1:5200" \
DASHBOARD_DIR="$PWD/unified-dashboard/dist" \
CLAUDE_OAUTH_CLIENT_ID="$CLAUDE_OAUTH_CLIENT_ID" \
CLAUDE_OAUTH_CALLBACK_URL="$CLAUDE_OAUTH_CALLBACK_URL" \
pnpm --dir orch-server-ts start
```

In a second terminal, start the worker from the repository root so it loads `.env.soul-server-ts`:

```bash
node soul-server-ts/dist/main.js
```

For unbundled worker development, you can also run:

```bash
pnpm --dir soul-server-ts dev
```

Default local endpoints:

- Web dashboard: `http://127.0.0.1:5200/`
- Orchestrator health check: `http://127.0.0.1:5200/api/health`
- Worker health check: `http://127.0.0.1:4205/health`
- Node-local internal MCP endpoint: `http://127.0.0.1:4206/mcp/internal` (bound to `127.0.0.1`; the public worker listener has no MCP route)

## Dashboard dev server

To run the Vite development server for `unified-dashboard` with hot module replacement, point it at a running orchestrator with `VITE_API_BASE` (the dev server refuses to start without it):

```bash
VITE_API_BASE=http://localhost:5200 pnpm --dir unified-dashboard dev
```

`vite preview` (a static preview of a built `dist/`) starts without `VITE_API_BASE`; set it only when the preview should proxy `/api` and `/cogito` to an orchestrator.

## Mobile app dev start

`soul-app` is a standalone Expo package outside the pnpm workspace. Install its dependencies and start the Expo development server with `npm --prefix soul-app`:

```bash
npm --prefix soul-app ci
npm --prefix soul-app start
```

Platform-specific Expo scripts in [`soul-app/package.json`](../../soul-app/package.json):

```bash
npm --prefix soul-app run ios
npm --prefix soul-app run android
npm --prefix soul-app run web
```
