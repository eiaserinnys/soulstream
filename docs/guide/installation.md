# Installation

This guide covers the Linux one-line installer (including updates, Tailscale Serve, and uninstalling), the Windows full installer, the Windows worker installer, and running the full Soulstream stack from source.

## Linux one-line installer

Run the installer as `root` on a fresh Debian 13 (`x86_64`) server. Recommended specs are at least 2 vCPU, 4 GB RAM, and 40 GB disk. The installer checks for at least 3.5 GiB RAM and 20 GB free space on `/`.

```bash
bash -c 'set -euo pipefail; (command -v curl >/dev/null 2>&1 && test -f /etc/ssl/certs/ca-certificates.crt) || (apt-get update && apt-get install -y curl ca-certificates); tmp=$(mktemp); trap "rm -f \"$tmp\"" EXIT; curl -fsSL https://raw.githubusercontent.com/eiaserinnys/soulstream/beta/install/install.sh -o "$tmp"; bash "$tmp" --backends claude,codex'
```

`--backends` takes a comma-separated list of `claude`, `codex`, and `antigravity` (default: `claude,codex`). The first backend becomes the backend for the default `seosoyoung` and `seosoyoung-pas` profiles. Without `--ref` or `--atom-ref`, both Soulstream and atom install from the verified `origin/beta` branch. For the latest development commits, download `install.sh` from `main` instead of `beta` and pass `--ref main --atom-ref main` together. You can also pin a revision with `--ref <ref>` for Soulstream or `--atom-ref <ref>` for atom (branch, tag, or commit).

Administrator password options (shared by the Soulstream dashboard and atom):

- On a fresh interactive install (`stdin` is a terminal and `/dev/tty` is available), the installer asks twice for an administrator password before installing packages. Press Enter at the first prompt to generate a random 24-character hex password and print it once on your terminal when installation finishes (never in `/var/log/soulstream-install.log`).
- `--admin-password-file <path>`: read the administrator password from a single-line file without prompting (works on both fresh installs and updates). No command-line value flag is provided so the password never appears in `ps`.
- `--set-admin-password`: prompt on `/dev/tty` for a new administrator password (or press Enter to generate a new one) even when a password already exists.
- When no password flag is given and `stdin` is not a terminal (or `/dev/tty` cannot be opened), a fresh install generates a random password without stopping, saves it to `/home/soulstream/soulstream/.admin-password` (`0600`), and prints the `sudo cat` command at the end. For unattended runs that inherit a pseudo-terminal, append `</dev/null` to skip the prompt.
- Password rules: 8 to 128 printable ASCII characters on a single line, no leading or trailing space, and none of `#`, `\`, `'`, `"`, or `` ` ``. Interior spaces and other ASCII symbols (including `$`, `!`, `@`, `%`, `^`, `&`, `*`, `=`, `;`, and `:`) are preserved verbatim in both Soulstream and atom.

On one server, the installer sets up:

- Soulstream (dashboard, orchestrator, and worker).
- atom, a knowledge tree for instructions and skills (`/home/soulstream/atom`, loopback port `4200`), with its own PostgreSQL database and API key.
- Starter instructions and skills in atom.
- Default agent profiles `seosoyoung` and `seosoyoung-pas`.
- One default profile per selected backend (`claude-default`, `codex-default`, `antigravity-default`), plus `card-orchestrator` when you select `claude`.
- Three systemd services, enabled and started: `soulstream-atom.service`, `soulstream-orch.service`, and `soulstream-worker.service`.

The installer installs required packages, creates the `soulstream` user, sets up Node.js, the selected CLIs, and PostgreSQL, and clones Soulstream and atom. It builds and starts atom, issues an API key, loads starter instructions, then configures Soulstream, builds it, initializes the schema, and starts it under systemd. It creates the local workspace folder and checks service connectivity and authentication. The log is `/var/log/soulstream-install.log`.

Starter instructions load once, on a fresh install, when the atom tree is empty. Reruns and updates never overwrite instructions you edited in atom, and new starter items are not added to existing installations. Warnings under `Atom instructions:` mean:

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

In the default password mode, both services listen on `127.0.0.1` only. Forward both ports over SSH to open the dashboard and atom locally:

```bash
ssh -L 127.0.0.1:5200:127.0.0.1:5200 -L 127.0.0.1:4200:127.0.0.1:4200 <user>@<server>
```

Open Soulstream at `http://127.0.0.1:5200` and atom at `http://127.0.0.1:4200` with the same administrator password. Use the password you entered during installation (or the generated one shown once on your terminal); if you installed non-interactively or need to look it up later, read it on the server with `sudo cat /home/soulstream/soulstream/.admin-password`. The atom button (`atom 열기`) in the global dashboard toolbar also opens atom (`ATOM_PUBLIC_URL`) in a new browser tab.

In a new browser, the dashboard opens the persistent assistant session view (`/persistent`) by default. You can change this in **Settings > Appearance** (`설정 > 화면과 읽기`). The installer sets `PERSISTENT_SESSION_BOOTSTRAP=true`, so when you connect the first coding agent, the dashboard creates one default persistent session (`seosoyoung-pas`) and opens it.

### Updating

Re-run the same one-line command to update. Without `--ref` or `--atom-ref`, both repositories move to the latest `origin/beta` commit of the verified channel. Pass the same `--backends` value you installed with (omitting it defaults to `claude,codex`). An installation without atom also gains atom with the same command.

Before it stops any service, the installer checks both repositories. If it finds uncommitted changes, a non-git directory, an unresolvable revision, local commits not on `origin`, a Soulstream revision predating atom support, a current `HEAD` that is not an ancestor of the target revision (this includes a server installed from `main` that is ahead of `beta`), or a running installer that differs from `install/install.sh` at the target revision, it aborts without stopping any service. For an existing installation the two ancestor checks and the installer comparison run before the installer changes packages, Node.js, or the CLIs. Servers installed from `main` should keep using the installer from `main` and `--ref main --atom-ref main` until `beta` catches up. These two checks apply only when you do not pass `--ref` or `--atom-ref`. Untracked installer files (config and `.env`) do not block updates.

Updates preserve secrets, the existing administrator password (without prompting, reading `/home/soulstream/soulstream/.admin-password` first), both databases (`soulstream` and `atom`), the existing workspace, unmanaged `.env` lines, and edited config files. Edited managed files stay untouched; new defaults go beside them as `<file>.installer-new` and appear under `Configuration:` ([managed config files](configuration.md#files-the-linux-installer-manages)).

After the checks pass, the installer stops `soulstream-worker`, `soulstream-orch`, and `soulstream-atom`, then checks out, builds, migrates, and restarts them. The finish output shows previous and new revisions for both repositories. If a step fails after stopping services, all three stay stopped and `/home/soulstream/soulstream/.local/install-state.json` records the failed step and revisions; fix the cause and re-run to recover. The installer does not roll anything back automatically, neither the checked-out revisions nor the databases. It dumps `soulstream` before non-additive schema changes and any non-empty `atom` database before every migration to `/home/soulstream/soulstream/.local/backups/` (mode `0600`, latest 3 per database). While you re-run a failed update, the installer keeps that update's first `atom` backup and takes no new one. Failure output and `install-state.json` (`backups`) list backup paths and restore commands. Restore only when discarding the new revision: keep services stopped, check out a compatible revision, and restore into an empty database from a `root` shell.

### Changing the administrator password

Re-run the same one-line install command with `--set-admin-password` on an interactive SSH session, or pass `--admin-password-file <path>` for non-interactive rotation (keep the same `--backends`, and include `--tailscale` if your server uses Tailscale mode):

```bash
bash -c 'set -euo pipefail; tmp=$(mktemp); trap "rm -f \"$tmp\"" EXIT; curl -fsSL https://raw.githubusercontent.com/eiaserinnys/soulstream/beta/install/install.sh -o "$tmp"; bash "$tmp" --backends claude,codex --set-admin-password'
```

Non-interactive rotation from a root-owned `0600` file:

```bash
bash -c 'set -euo pipefail; tmp=$(mktemp); trap "rm -f \"$tmp\"" EXIT; curl -fsSL https://raw.githubusercontent.com/eiaserinnys/soulstream/beta/install/install.sh -o "$tmp"; bash "$tmp" --backends claude,codex --admin-password-file /root/.soulstream-pass'
```

The command also updates the server to the latest verified version on the `beta` channel (unless `--ref` and `--atom-ref` are set), and the new password applies to both the dashboard and atom right away. The installer validates the new password before stopping services. Once services stop, it writes `/home/soulstream/soulstream/.admin-password` first, then updates `/home/soulstream/atom/.env` and restarts `soulstream-atom`, verifies atom seed access, and in password mode updates `/home/soulstream/soulstream/.env.orch`, restarts `soulstream-orch`, and verifies dashboard login. If a later step fails, re-running the installer picks up the new password from `.admin-password` and finishes updating the remaining files. Do not edit only one `.env` file by hand.

### Tailscale Serve

Add `--tailscale` to the install command for passwordless Soulstream access with an allowed Tailscale account. Enable MagicDNS and HTTPS in your tailnet. Approve any login URL within 10 minutes (already-connected devices skip approval).

```bash
bash -c 'set -euo pipefail; tmp=$(mktemp); trap "rm -f \"$tmp\"" EXIT; curl -fsSL https://raw.githubusercontent.com/eiaserinnys/soulstream/beta/install/install.sh -o "$tmp"; bash "$tmp" --backends claude,codex --tailscale --tailscale-user owner@example.com'
```

If you run a local copy such as `bash install/install.sh` instead, pass `--ref` and `--atom-ref` as well; without them the installer stops when the local file differs from `install/install.sh` at `origin/beta`.

Personal devices default to their own account when you omit `--tailscale-user`; tagged devices require it. To use an auth key, store it in a file and pass `--tailscale-auth-key-file <path>` so it never enters process arguments. After installation, open the printed HTTPS URL from a tailnet device signed in as that account. Local processes on the server can forge identity headers, so run only trusted processes on the host.

atom is served on `:8443` of the same host (`https://<MagicDNS-name>:8443`) and signs in with the administrator password you set during installation (also saved in `/home/soulstream/soulstream/.admin-password`, readable with `sudo cat`).

Re-run without `--tailscale` to return to password mode. To remove Serve access and disconnect the device, run `tailscale serve reset && tailscale logout`.

### Uninstalling

Run the uninstaller as `root` on the dedicated server where you installed Soulstream:

```bash
bash -c 'set -euo pipefail; tmp=$(mktemp); trap "rm -f \"$tmp\"" EXIT; curl -fsSL https://raw.githubusercontent.com/eiaserinnys/soulstream/beta/install/uninstall.sh -o "$tmp"; bash "$tmp"'
```

For non-interactive runs, pass `--yes` inside the inner command:

```bash
bash -c 'set -euo pipefail; tmp=$(mktemp); trap "rm -f \"$tmp\"" EXIT; curl -fsSL https://raw.githubusercontent.com/eiaserinnys/soulstream/beta/install/uninstall.sh -o "$tmp"; bash "$tmp" --yes'
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

## Security and permissions

The Linux installer sets up a personal automation environment: coding agents that edit files and run commands on the server without asking you first. Read this section before you install.

### Accounts and network access

- The three services run as the `soulstream` user, not `root`.
- The orchestrator (port `5200`), the worker (`4205`), and atom (`4200`) listen on `127.0.0.1` only. The installer does not configure a firewall, so anything else on the server follows your own network rules.
- In the default password mode, the dashboard and atom ask for the shared administrator password. The worker's MCP endpoint requires an `Authorization: Bearer` token (`MCP_REQUIRE_AUTH=true`).
- The `soulstream` user is created with `useradd -m -d /home/soulstream -s /bin/bash soulstream` and no group options. The installer does not add it to the `sudo` group or write a sudoers entry.
- If `/root/.ssh/authorized_keys` exists and the `soulstream` user has no `authorized_keys` yet, the installer copies the file to `/home/soulstream/.ssh/authorized_keys`. Every key that can log in as `root` can then log in as `soulstream` too.

### What agents can do

The installed worker configuration sets `SESSION_ISOLATION_MODE=off` in `/home/soulstream/soulstream/.env.soul-server-ts`, so sessions run without isolation. This guide does not describe how to turn isolation on. Each backend runs without approval prompts:

- **Claude**: the permission mode defaults to `bypassPermissions` (the SDK option `allowDangerouslySkipPermissions` is set). An agent profile can change it with `claude_permission_mode`, and the installed profiles do not.
- **Codex**: the installer sets `CODEX_ADAPTER_MODE=app-server` when you select `codex`. Threads start with `approvalPolicy: "never"` and `sandbox: "danger-full-access"`, and turns use `sandboxPolicy: { type: "dangerFullAccess" }`. The SDK transport uses `approvalPolicy: "never"` and `sandboxMode: "danger-full-access"`.
- **Antigravity**: `agy` starts with `--dangerously-skip-permissions`.

Agents therefore edit files and run commands as `soulstream`, anywhere that account has access. They can read the files the installer creates for the services, because the `soulstream` user owns them. Mode `0600` keeps other users out, not these agents:

- `/home/soulstream/soulstream/.env.orch` and `.env.soul-server-ts` (`0600`): the database password, the bearer token, the JWT secret, and the atom API key between them. `.env.orch` also holds the administrator password in password mode.
- `/home/soulstream/atom/.env` (`0600`): the atom database URL and JWT secret, and the administrator password.
- `/home/soulstream/soulstream/.admin-password` and `.atom-api-key` (`0600`).
- `/home/soulstream/soulstream/.local/backups/` (directory `0700`, dumps `0600`): database dumps from updates, which contain your session history, cards, and atom documents.
- The saved Claude, Codex, and Antigravity logins under `/home/soulstream`.

Install on a dedicated server or VM that holds no other data, and do not put credentials there that you would not give to the agents.

## Requirements

- **Node.js**: 22.5 or newer (`>=22.5`).
- **pnpm**: `10.32.1` (managed via `corepack enable`).
- **PostgreSQL**: required by `orch-server-ts` for canonical persistence. Execution workers (`soul-server-ts`) do not connect to PostgreSQL.
- **Python**: 3.11 or newer (checked by the Windows worker installer).

## Windows full installer

The PowerShell installer ([`install/install-windows.ps1`](../../install/install-windows.ps1)) installs the whole stack natively on one Windows machine, with no Docker and no WSL: the orchestrator, a local worker, atom, and the dashboard. It needs Windows 10 or 11 on x64 and an elevated PowerShell (Run as administrator); Windows PowerShell 5.1 and PowerShell 7 both work, under any execution policy. Allow about 4 GB of free RAM and 10 GB of disk.

```powershell
irm https://raw.githubusercontent.com/eiaserinnys/soulstream/main/install/install-windows.ps1 | iex
```

To pass options, run the script as a script block:

```powershell
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/eiaserinnys/soulstream/main/install/install-windows.ps1'))) -WorkerPort 4305
```

The installer follows the `main` channel of Soulstream and atom.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `-InstallRoot` | `%LOCALAPPDATA%\SoulstreamServer` | Install folder. A folder that is not empty and was not created by this installer is refused |
| `-WorkerPort` | `4205` | Worker port. The internal MCP port is the next one |
| `-Backends` | `claude,codex` | Coding agents to set up. Antigravity is not supported on Windows |
| `-Ref`, `-AtomRef` | `main` | Branch, tag, or commit of Soulstream and atom |
| `-PostgresPassword` | none | Superuser password of an existing PostgreSQL 17 |
| `-AdminPasswordFile` | none | Single-line file with the administrator password. Without it, one is generated |
| `-NonInteractive` | off | Never prompt |

What it installs:

- Missing tools through `winget`: Node.js 22.5 or newer, Git, Python 3.11 or newer, and pnpm `10.32.1`.
- PostgreSQL 17. An existing `postgresql-x64-17` service is used and set to start automatically. If there is none, the installer installs it on `localhost` only and keeps the superuser password in `<InstallRoot>\.postgres-superuser-password`.
- The `soulstream` and `atom` databases and the `soulstream` role.
- Soulstream and atom under `<InstallRoot>\soulstream` and `<InstallRoot>\atom`, built from source. The agent workspace is `<InstallRoot>\workspace`.
- The Claude Code CLI (official Windows installer) and the Codex CLI (`npm install -g @openai/codex`) if you selected them and they are missing. Existing CLIs and their settings in your user folder are not touched. The Claude installer puts `claude.exe` in `%USERPROFILE%\.local\bin` without adding it to `PATH`; the worker finds it there, and your `PATH` is not changed. If a selected CLI is still missing, the installer stops and tells you how to install it or leave it out with `-Backends`.
- [Haniel](https://github.com/eiaserinnys/haniel) in `<InstallRoot>\venv`, running atom (`4200`), the orchestrator (`5200`), and the worker as three services. Everything listens on `127.0.0.1` only. If a port is taken, the installer tells you which program holds it and stops.

After it finishes, open `http://127.0.0.1:5200` and sign in with the administrator password. The password is printed at the end and saved in `<InstallRoot>\soulstream\.admin-password`. Atom is at `http://127.0.0.1:4200` with the same password. If the atom dashboard does not build, atom still serves its API, the dashboard hides its atom link, and the installer lists this under Notes.

To connect a coding agent, open **Settings > Coding agents** (`설정 > 코딩 에이전트`) in the dashboard. For Claude, expand the row and choose Add account (`계정 추가`). For Codex, open the URL the dashboard shows and enter the one-time code.

Soulstream starts from a scheduled task named `SoulstreamServer` that runs at your logon. It does not store your Windows password, so it runs only while you are signed in. The installer starts the task right away. If the task does not start in that session, the installer starts Soulstream directly and says so; the task takes over at your next logon.

Run the same command again to rebuild: the secrets, the administrator password, and the databases stay, the configuration is rewritten, and the services restart. Files you edited under `config\` are kept, and the new version is written next to them as `.installer-new`. The installer does not upgrade an existing database. If the database is behind the version you install, it stops and says so.

Limits on Windows: session isolation is off, and sessions run in the worker process instead of separate runner processes. Antigravity and Tailscale are not supported.

To remove it, run this in an elevated PowerShell. Add `-InstallRoot <folder>` if you installed somewhere else, and `-PostgresPassword <password>` if the installer did not install PostgreSQL itself (otherwise it asks):

```powershell
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/eiaserinnys/soulstream/main/install/uninstall-windows.ps1')))
```

This stops and deletes the task and its processes, drops the `soulstream` and `atom` databases and the `soulstream` role, and deletes the install folder. PostgreSQL and the coding agent CLIs stay installed. The installer marks its folder with a `.soulstream-windows-install` file; without that file the uninstaller removes nothing, so the Soulstream desktop app in `%LOCALAPPDATA%\Soulstream` is never touched.

Logs are in `<InstallRoot>\logs`: `haniel.log`, `haniel.out.log`, `haniel.err.log`, and one file per service (`atom.log`, `orch.log`, `worker.log`). When a step fails, the installer prints the end of the relevant log.

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

## If an install or update fails

Read the failure message, then check the logs of the failed service with `journalctl -u soulstream-orch`, `journalctl -u soulstream-worker`, or `journalctl -u soulstream-atom`. The installer log is `/var/log/soulstream-install.log`. Fix the cause, then run the same command again.
