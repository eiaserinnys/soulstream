# Installation

## 리눅스 한 줄 설치

빈 Debian 13 x86_64 서버에서 root로 실행합니다. 2 vCPU, RAM 4 GB, 디스크 40 GB 이상을 권장합니다. 설치기는 RAM 3.5 GiB와 루트 파일시스템의 여유 공간 20 GB 이상을 확인합니다.

```bash
bash -c 'set -euo pipefail; (command -v curl >/dev/null 2>&1 && test -f /etc/ssl/certs/ca-certificates.crt) || (apt-get update && apt-get install -y curl ca-certificates); tmp=$(mktemp); trap "rm -f \"$tmp\"" EXIT; curl -fsSL https://raw.githubusercontent.com/eiaserinnys/soulstream/main/install/install.sh -o "$tmp"; bash "$tmp" --backends claude,codex'
```

`--backends`는 `claude`, `codex`, `antigravity` 중 원하는 백엔드를 쉼표로 구분합니다. 기본값은 `claude,codex`이며 첫 백엔드가 기본 에이전트 서소영과 서소영 (PAS)의 백엔드가 됩니다. 선택 사항인 `--ref <브랜치, 태그 또는 커밋>`으로 설치할 소울스트림 리비전을, `--atom-ref <브랜치, 태그 또는 커밋>`으로 설치할 atom 리비전을 지정합니다.

한 서버에 다음이 함께 설치됩니다.

- 소울스트림(오케스트레이터와 워커)
- atom(지침과 스킬을 담는 지식 트리, `/home/soulstream/atom`, 루프백 포트 4200)
- 기본 지침: 설치기에 들어 있는 시작 지침과 스킬을 atom에 싣습니다.
- 기본 에이전트 서소영(`seosoyoung`)과 서소영 (PAS)(`seosoyoung-pas`)
- 고른 백엔드마다 기본 에이전트(`claude-default`, `codex-default`, `antigravity-default`). `claude`를 고르면 카드 오케스트레이터 프로필도 만듭니다.

설치기는 필수 패키지, 전용 사용자, Node.js, 선택한 CLI와 PostgreSQL을 준비하고 소울스트림과 atom 소스를 클론합니다. atom을 빌드해 시작하고 API 키를 발급한 뒤 기본 지침을 싣고, 이어서 소울스트림의 설정, 빌드, 스키마 초기화를 마친 뒤 systemd 서비스를 시작합니다. 로컬 작업실을 만들고 서비스 연결과 인증을 확인합니다. 로그는 `/var/log/soulstream-install.log`에 남습니다.

기본 지침은 설치 때 한 번만 싣습니다. 설치 뒤 atom에서 고친 지침은 다시 설치해도 덮어쓰지 않습니다. 설치 끝 안내에 `Atom instructions:` 경고가 나오면 다음 뜻입니다.

- atom에 이미 트리가 있어 기본 지침을 싣지 않고 기존 트리를 그대로 두었습니다.
- 설치 뒤 바뀐 시드 카드가 있어 그 카드는 고치지 않고 보존했습니다.
- 설치기가 설정에 쓰는 노드(예: 스킬 카탈로그)가 atom에서 지워져 그 연결을 비웠습니다.

설치가 끝나기 전에 모델 프리셋 상태를 갱신합니다. 최대 여섯 번 시도하며 각 요청은 최대 60초, 재시도 간격은 10초입니다. 갱신에 실패해도 설치는 계속됩니다.

설치가 끝나면 안내된 명령으로 선택한 CLI에 로그인합니다. Codex는 ChatGPT 보안 설정에서 기기 코드 로그인을 켜야 합니다. Antigravity는 `ssh soulstream@<서버>`로 직접 접속해 `~/.local/bin/agy`에서 로그인하고 `/exit`로 나옵니다. 로그인 후 프리셋은 5분 안에 갱신되며, 즉시 갱신 명령도 설치 결과에 표시됩니다.

대시보드와 atom은 SSH 터널을 연 뒤 로컬 브라우저에서 접속합니다.

```bash
ssh -L 127.0.0.1:5200:127.0.0.1:5200 -L 127.0.0.1:4200:127.0.0.1:4200 <사용자>@<서버>
```

소울스트림은 <http://127.0.0.1:5200>, atom은 <http://127.0.0.1:4200>에서 같은 관리자 비밀번호로 로그인합니다. 설치기는 비밀번호를 화면에 찍지 않습니다. 서버에서 `sudo cat /home/soulstream/soulstream/.admin-password`로 확인합니다.

PAS 세션은 대시보드에서 영구 세션을 만들어 시작합니다. 영구 세션의 기본 에이전트는 서소영 (PAS)입니다.

같은 명령을 다시 실행하면 비밀 값, 기존 작업실과 설치기가 관리하지 않는 환경 설정 줄을 보존합니다. 기존 클론의 HEAD는 `--ref`를 주지 않으면 그대로 유지합니다. `--ref`를 주면 작업 트리가 깨끗할 때 해당 리비전을 체크아웃합니다. 버전 업데이트 도구와 제거 도구는 포함하지 않습니다. 기존 소울스트림 클론이 atom 지원 전의 리비전이면(1단계 설치본) 이 설치기는 서비스와 파일을 바꾸기 전에 멈춥니다.

### Tailscale Serve

설치 명령의 마지막 인자에 `--tailscale`을 더하면 허용된 Tailscale 계정으로 소울스트림에 비밀번호 없이 접속합니다. 로그인 URL이 표시되면 10분 안에 승인합니다. 이미 연결된 기기는 승인을 건너뜁니다. tailnet에서 MagicDNS와 HTTPS를 켜야 합니다.

```bash
bash install/install.sh --tailscale --tailscale-user owner@example.com
```

개인 기기는 `--tailscale-user`를 생략하면 기기의 계정을 사용합니다. 태그 기기는 허용할 사람의 로그인 이름을 명시해야 합니다. 인증 키를 쓰려면 키를 파일에 담아 `--tailscale-auth-key-file <경로>`로 넘깁니다. 설치기는 파일 경로만 Tailscale에 전달하므로 키가 프로세스 인자에 남지 않습니다. 설치가 끝나면 표시된 HTTPS 주소를 해당 계정의 tailnet 기기에서 엽니다. 서버의 로컬 프로세스는 신원 머리를 위조할 수 있으므로 신뢰하는 프로세스만 실행해야 합니다.

atom은 같은 주소의 `:8443`(`https://<서버의 MagicDNS 이름>:8443`)으로 열립니다. atom은 Tailscale 신원 대신 관리자 비밀번호로 로그인하며, 비밀번호는 Tailscale 모드에서도 `/home/soulstream/soulstream/.admin-password`에 보관됩니다(`sudo cat`으로 확인).

`--tailscale` 없이 다시 설치하면 기존 관리자 비밀번호로 돌아갑니다. Serve 접근과 기기 연결을 제거하려면 `tailscale serve reset && tailscale logout`을 실행합니다.

This guide covers installing a remote Windows worker with the PowerShell installer and running the full Soulstream stack from source.

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
