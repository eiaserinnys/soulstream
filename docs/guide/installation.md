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

설치가 끝나면 대시보드의 설정 → 코딩 에이전트에서 Claude, Codex, Antigravity를 연결합니다. 서버에서 따로 명령을 실행할 필요가 없습니다. 연결이 끝나면 그 노드의 모델 프리셋이 곧바로 다시 읽힙니다.

- Claude는 계정 풀 로그인을 씁니다. 설치기가 계정 풀을 켠 채로 시작하므로 계정이 0개여도 됩니다. 이미 `~/.claude/.credentials.json`에 SSH 로그인 자격이 있으면 워커가 처음 시작할 때 그 자격을 풀로 옮깁니다.
- Codex는 기기 코드 방식입니다. 대시보드가 보여 주는 주소를 브라우저에서 열고 함께 보이는 일회용 코드를 입력하면 연결됩니다. ChatGPT 보안 설정에서 기기 코드 로그인을 켜야 합니다.
- Antigravity는 대시보드가 보여 주는 Google 인증 주소를 브라우저에서 열고, 인증 뒤에 나오는 코드를 대시보드에 붙여 넣으면 연결됩니다.

대시보드를 쓸 수 없을 때는 SSH로 접속해 Codex와 Antigravity에 직접 로그인할 수도 있습니다. Codex는 `sudo -Hu soulstream /usr/local/bin/codex login --device-auth`, Antigravity는 `soulstream` 사용자로 `~/.local/bin/agy`를 실행해 로그인하고 `/exit`로 나옵니다. 이 방식으로 로그인한 뒤 프리셋은 5분 안에 갱신되며, 즉시 갱신 명령도 설치 결과에 표시됩니다. Claude의 SSH 로그인 안내는 없습니다.

대시보드와 atom은 SSH 터널을 연 뒤 로컬 브라우저에서 접속합니다.

```bash
ssh -L 127.0.0.1:5200:127.0.0.1:5200 -L 127.0.0.1:4200:127.0.0.1:4200 <사용자>@<서버>
```

소울스트림은 <http://127.0.0.1:5200>, atom은 <http://127.0.0.1:4200>에서 같은 관리자 비밀번호로 로그인합니다. 설치기는 비밀번호를 화면에 찍지 않습니다. 서버에서 `sudo cat /home/soulstream/soulstream/.admin-password`로 확인합니다.

PAS 세션은 대시보드에서 영구 세션을 만들어 시작합니다. 영구 세션의 기본 에이전트는 서소영 (PAS)입니다.

### 업데이트

같은 한 줄 명령을 다시 실행하면 업데이트입니다. `--ref`(atom은 `--atom-ref`)를 주지 않으면 소울스트림과 atom 두 저장소를 원격 `main`의 최신 커밋으로 옮깁니다. 다시 실행할 때는 처음과 같은 `--backends`를 줍니다. 빼면 `claude,codex`가 됩니다. atom 없이 설치한 1단계 설치본도 같은 명령으로 atom까지 올라갑니다.

설치기는 실행 중인 서비스를 멈추기 전에 두 저장소를 확인합니다. 커밋하지 않은 변경, git 체크아웃이 아닌 경로, 찾을 수 없는 리비전, 원격에 없는 지역 커밋, atom 지원 전의 소울스트림 리비전이 있으면 실행 중인 서비스를 건드리지 않고 멈춥니다. 설치기가 만든 추적하지 않는 파일(설정 파일과 `.env` 파일)은 막지 않습니다.

업데이트는 비밀 값, `soulstream`과 `atom` 두 데이터베이스, 기존 작업실, 설치기가 관리하지 않는 환경 설정 줄, 고친 설정 파일을 보존합니다. 고친 설정 파일은 그대로 두고 새 기본본을 같은 자리의 `.installer-new` 파일로 남기며, 설치 끝 안내의 `Configuration:` 아래에 알립니다([관리 설정 파일](configuration.md#files-the-linux-installer-manages)). 업데이트는 기존 atom 지침을 바꾸지 않으며, 새 기본 지침은 새 설치에만 들어갑니다.

확인을 마치면 세 서비스(`soulstream-worker`, `soulstream-orch`, `soulstream-atom`)를 멈춘 뒤 체크아웃, 빌드, 마이그레이션, 기동을 차례로 합니다. 설치 끝 안내에 두 저장소의 이전 리비전과 새 리비전이 나옵니다. 멈춘 뒤에 실패하면 세 서비스를 멈춘 채로 끝나고, 실패한 단계와 두 저장소의 리비전이 `/home/soulstream/soulstream/.local/install-state.json`에 남습니다. 원인을 고친 뒤 같은 명령을 다시 실행하면 복구합니다. 데이터베이스는 자동으로 되돌리지 않습니다. 그 대신 비추가형 스키마 변경을 적용하기 전에 `soulstream` 데이터베이스를, 업데이트할 때마다 마이그레이션 전에 비어 있지 않은 `atom` 데이터베이스를 `/home/soulstream/soulstream/.local/backups/`에 덤프합니다. 덤프 파일의 권한은 0600이고, 데이터베이스마다 최근 3개를 남깁니다. 실패 안내에 백업 경로와 복원 명령이 나오며 `install-state.json`의 `backups`에도 남습니다. 복원은 새 리비전을 버릴 때만 합니다. 서비스를 멈춘 채 호환 리비전을 체크아웃하고, 빈 대상 데이터베이스에 root 셸로 복원합니다. 제거 도구는 포함하지 않습니다.

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
