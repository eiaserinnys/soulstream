# Soulstream

![Soulstream dashboard](docs/screenshots/dashboard.png)

**Soulstream is a self-hosted control plane for running coding agents as an ongoing service.** It combines a live operations dashboard, durable work cards and sessions, multi-node execution, and agent-facing MCP tools in one system.

Instead of treating an agent as a terminal process that disappears after one prompt, Soulstream gives it a durable workspace. Sessions stream in real time, folders and cards carry context across turns, workers run across multiple machines, and the central control plane keeps canonical history in PostgreSQL.

## What Soulstream does

- **Long-lived agent sessions** with live streaming output, follow-up messages, mid-turn intervention, file attachments, and resumable history.
- **Structured work cards** inside hierarchical folders, tracking the request, check items with evidence, a one-line status (`now`), user questions, and review completion.
- **Persistent assistant sessions** with a live report board, active task lists, session monitoring, and weekly quota headroom.
- **Five execution backends** configured through node-local agent profiles and model presets: Claude, Codex, OpenAI Agents, Antigravity, and OpenCode.
- **Multi-node routing** where the TypeScript orchestrator (`orch-server-ts`) dispatches authenticated WebSocket commands to TypeScript workers (`soul-server-ts`).
- **Built-in MCP tools** for service reflection, session search, git worktrees, on-demand skill loading (`load_skill`), recurring jobs, and card or folder management.
- **Release-safe operations** with [Haniel](https://github.com/eiaserinnys/haniel) manifests that keep PostgreSQL migration authority on the central orchestrator while remote workers stay database-free.

## Interface previews

![Card detail in review with check items, recorded results, and the linked review session](docs/screenshots/card-detail.png)

<p>
  <img src="docs/screenshots/persistent-session.png" alt="Persistent assistant session with the report board and chat" width="74.5%">
  <img src="docs/screenshots/mobile.png" alt="The same persistent session on a phone-sized screen" width="21.5%">
</p>

The screenshots use demo data served by a Playwright fixture. Regenerate them with `pnpm --dir unified-dashboard capture:readme`.

## Quick install on a fresh Linux server

Run the one-line installer as `root` on a fresh Debian 13 (`x86_64`) server. The recommended size is at least 2 vCPU, 4 GB RAM, and 40 GB disk.

```bash
bash -c 'set -euo pipefail; (command -v curl >/dev/null 2>&1 && test -f /etc/ssl/certs/ca-certificates.crt) || (apt-get update && apt-get install -y curl ca-certificates); tmp=$(mktemp); trap "rm -f \"$tmp\"" EXIT; curl -fsSL https://raw.githubusercontent.com/eiaserinnys/soulstream/main/install/install.sh -o "$tmp"; bash "$tmp" --backends claude,codex'
```

`--backends` takes a comma-separated list of `claude`, `codex`, and `antigravity`. The default is `claude,codex`, and the first backend becomes the backend for the default `seosoyoung` and `seosoyoung-pas` profiles. For `--ref`, `--atom-ref`, `--tailscale`, and the other options, see [Installation](docs/guide/installation.md).

### What gets installed

On one server, the installer sets up:

- The Soulstream web dashboard and orchestrator (`orch-server-ts`).
- An execution worker (`soul-server-ts`).
- atom, a knowledge tree that holds instructions and skills, with its own PostgreSQL database and API key.
- Starter instructions and skills, loaded into atom.
- Default agent profiles: `seosoyoung`, `seosoyoung-pas`, one `<backend>-default` profile per selected backend, and `card-orchestrator` when you select `claude`.
- Three systemd services, enabled and started: `soulstream-atom.service`, `soulstream-orch.service`, and `soulstream-worker.service`.

Ports, paths, logs, and generated files are covered in [Installation](docs/guide/installation.md) and [Configuration](docs/guide/configuration.md).

### After installing

#### Open the dashboard and atom

In the default password mode, both services listen on `127.0.0.1` only. Forward both ports over SSH and open them in a local browser:

```bash
ssh -L 127.0.0.1:5200:127.0.0.1:5200 -L 127.0.0.1:4200:127.0.0.1:4200 user@example.com
```

Open Soulstream at `http://127.0.0.1:5200` and atom at `http://127.0.0.1:4200`. Both use the same administrator password. The installer does not print it, so read it on the server:

```bash
sudo cat /home/soulstream/soulstream/.admin-password
```

#### Connect coding agents

Sign in as the administrator, then open **Settings > Coding agents** (`설정 > 코딩 에이전트`) to connect Claude, Codex, and Antigravity from the browser:

- **Claude** uses the account pool that the installer turns on. Expand the Claude row and choose Add account (`계정 추가`).
- **Codex** uses device-code login. Open the URL the dashboard shows and enter the one-time code. If the dashboard reports that device code authentication is off, turn it on in the security section of your ChatGPT settings and try again.
- **Antigravity** uses Google authentication. Open the URL the dashboard shows and paste the returned code back into the dashboard.

If you cannot use the dashboard, [Installation](docs/guide/installation.md) describes SSH login for Codex and Antigravity.

#### First screen and persistent assistant session (PAS)

In a new browser, the dashboard opens the persistent assistant session view (`/persistent`) by default. You can change this in **Settings > Appearance** (`설정 > 화면과 읽기`).

The installer sets `PERSISTENT_SESSION_BOOTSTRAP=true`. When you connect the first coding agent, the dashboard creates one default persistent session (`seosoyoung-pas`) and opens it.

#### Open atom from the toolbar

The global dashboard toolbar has an atom button (`atom 열기`) that opens atom in a new browser tab.

### Updating

To update, run the same one-line install command again with the same `--backends` value. Without `--backends`, it falls back to `claude,codex`. Without `--ref` or `--atom-ref`, the Soulstream and atom repositories both move to the latest `origin/main`.

Before it stops any service, the installer checks both repositories. If it finds a problem, such as uncommitted changes or local commits that are not on `origin`, it aborts and leaves the running services alone.

Updates preserve generated secrets, the administrator password, both databases, workspace files, and configuration files you edited. Starter instructions are loaded into atom only on the first installation, when the atom tree is empty. Updates never overwrite instructions you edited in atom, and new starter items are not added to existing installations.

For backups, failure recovery, and managed-file details, see [Installation](docs/guide/installation.md) and [Configuration](docs/guide/configuration.md).

### Uninstalling

To remove Soulstream and atom from a dedicated Linux server, run the uninstaller as `root`:

```bash
bash -c 'set -euo pipefail; tmp=$(mktemp); trap "rm -f \"$tmp\"" EXIT; curl -fsSL https://raw.githubusercontent.com/eiaserinnys/soulstream/main/install/uninstall.sh -o "$tmp"; bash "$tmp"'
```

For non-interactive runs, pass `--yes` inside the inner command:

```bash
bash -c 'set -euo pipefail; tmp=$(mktemp); trap "rm -f \"$tmp\"" EXIT; curl -fsSL https://raw.githubusercontent.com/eiaserinnys/soulstream/main/install/uninstall.sh -o "$tmp"; bash "$tmp" --yes'
```

Before changing anything, the script lists what it found and prompts once on `/dev/tty` (if no terminal is available and you omit `--yes`, it exits without changes). It deletes the dedicated systemd services, the `soulstream` and `atom` PostgreSQL databases (sessions, cards, and atom documents), the `soulstream` user and `/home/soulstream` (workspace files, backups, administrator password, and coding-agent logins), the Tailscale Serve `/` routes for Soulstream and atom, and installer-recorded `/usr/local` tools. OS `apt` packages and your Tailscale device login stay in place; for the full removal list, backup commands, and failure handling, see [Uninstalling](docs/guide/installation.md#uninstalling).

## Other installation options

### Windows worker installer

Register a `soul-server-ts` worker on Windows (requires Python 3.11+ and Node.js 22.5+) against an existing `orch-server-ts` control plane:

```powershell
irm https://raw.githubusercontent.com/eiaserinnys/soulstream/main/install/install.ps1 | iex
```

See [Installation](docs/guide/installation.md) for non-interactive parameters and Haniel service defaults.

### Run from source

Running the full stack locally requires Node.js 22.5 or newer, pnpm 10.32.1, and PostgreSQL:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm --dir unified-dashboard build
pnpm --dir orch-server-ts build
pnpm --dir soul-server-ts build

cp soul-server-ts/config/agents.yaml.example soul-server-ts/config/agents.yaml

export DATABASE_URL=postgresql://user:password@127.0.0.1:5432/soulstream
node packages/db-schema/scripts/migrate.mjs fresh-install
```

See [Installation](docs/guide/installation.md) and [Configuration](docs/guide/configuration.md) for the `.env.soul-server-ts` worker file and orchestrator startup commands.

## Documentation

- [Concepts](docs/guide/concepts.md): folders, cards, sessions, persistent assistant sessions, agents, model presets, and nodes.
- [Architecture](docs/guide/architecture.md): system diagram, control plane and worker roles, multi-node routing, backends, and repository layout.
- [Installation](docs/guide/installation.md): Linux one-line installer, updates, Tailscale Serve, uninstalling, Windows worker installer, source build, database initialization, and local dev servers.
- [Configuration](docs/guide/configuration.md): orchestrator and worker environment variables, `agents.yaml`, installer-managed files, atom settings, the model catalog data file, and secret handling.
- [Agents and tools](docs/guide/agents-and-tools.md): skill catalog (`load_skill`), MCP tool groups, worktrees, pages, recurring jobs, custom views, attachments, and usage stats.
- [Development](docs/guide/development.md): package typecheck and test scripts, Playwright suites, screenshot regeneration, and internal architecture references.
- [Deployment](docs/guide/deployment.md): Haniel release manifests, central database migration authority, and worker rollout.
