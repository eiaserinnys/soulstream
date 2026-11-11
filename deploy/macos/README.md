# macOS 노드 부트스트랩

새 macOS 노드에 Haniel과 `soulstream-soul-server-ts`를 세우기 전에 확인할 것과, launchd로 Haniel을 띄우는 배선, Darwin 빌드 훅의 전제를 정리한다. 이 디렉토리의 점검 스크립트는 읽기 전용이며 아무것도 설치하거나 시작하지 않는다.

| 파일 | 역할 |
| --- | --- |
| `check-macos-node.sh` | 노드 선행 조건 점검. 실패가 있으면 종료 코드 1 |
| `haniel.macos.example.yaml` | 운영 `haniel.yaml`에 복사하는 repos, services, install.configs 조각 |
| `../haniel/build-core.sh` | Haniel `post_pull` 훅. Darwin이면 아래 Python 실행기로 넘긴다 |
| `../haniel/build_core_darwin.py` | macOS용 빌드 실행기. 표준 라이브러리만 사용 |

## 1. 선행 조건 점검

```bash
cd ~/haniel-root/services/soulstream/src/soulstream
SOUL_RUNNER_STATE_DIR=/tmp/ss-run bash deploy/macos/check-macos-node.sh
```

`soulstream` 체크아웃은 `haniel.macos.example.yaml`의 `cwd`와 `run`이 가리키는 `./services/soulstream/src/soulstream`에 있다.

점검 항목은 다음과 같다.

- `uname -s`가 `Darwin`인지, 아키텍처가 `arm64` 또는 `x86_64`인지
- Python 3.11 이상인지 (Haniel과 Darwin 빌드 실행기의 전제)
- Node 22.12 이상인지와 `node:sqlite`를 플래그 없이 읽을 수 있는지. 실제 `require("node:sqlite")` 프로브로 확인한다
- `pnpm`, `git` 설치 여부. 없으면 FAIL이며 설치는 빌드의 필수 선행 조건이다
- CLI 백엔드 `claude`, `codex`, `agy`의 발견 경로. 없으면 WARN이며 필수 실패는 아니다
- `SOUL_RUNNER_STATE_DIR`의 소켓 경로 UTF-8 바이트 길이. runner는 상태 디렉토리 아래에 24자 슬러그와 `/runner.sock`을 붙이므로 Darwin의 103바이트 상한을 넘지 않아야 한다

`/var/folders/...` 형태의 긴 경로는 상한을 넘기 쉽다. `/tmp/ss-run`처럼 짧은 절대 경로를 쓴다. Node 22.12는 `--experimental-sqlite` 없이는 `node:sqlite`를 읽지 못하므로, 플래그 없는 운영을 위해 22.13 이상을 권장한다.

## 2. Haniel 실행기를 launchd로 띄우기

Linux 노드의 systemd 유닛 자리에 macOS에서는 LaunchAgent를 쓴다. Haniel 본체는 이 리포지토리에 없으므로 실행 명령은 운영자가 이미 쓰는 시작 명령을 그대로 넣는다.

`~/haniel-root/haniel-runner.sh`:

```bash
#!/bin/bash
set -euo pipefail

HANIEL_ROOT="/Users/your-user/haniel-root"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.npm-global/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="/Users/your-user"
cd "$HANIEL_ROOT"

# 아래 exec 줄은 운영자가 Linux 노드에서 쓰는 Haniel 시작 명령으로 바꾼다.
exec python3 "$HANIEL_ROOT/haniel.py" --config "$HANIEL_ROOT/haniel.yaml"
```

`chmod +x haniel-runner.sh`로 실행 권한을 준다. launchd는 로그인 셸 프로필을 읽지 않으므로 PATH를 plist와 스크립트 양쪽에 둔다. Homebrew로 설치한 `node`와 `pnpm`이 `/opt/homebrew/bin`에 있고, 이 디렉토리가 PATH에 없으면 `run: node ...` 서비스가 기동하지 못한다.

`~/Library/LaunchAgents/com.haniel.runner.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.haniel.runner</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/your-user/haniel-root/haniel-runner.sh</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/your-user/haniel-root</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/your-user/haniel-root/logs/haniel-runner.out.log</string>
  <key>StandardErrorPath</key><string>/Users/your-user/haniel-root/logs/haniel-runner.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>/Users/your-user</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/Users/your-user/.local/bin:/Users/your-user/.npm-global/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
```

등록과 재적용:

```bash
mkdir -p ~/haniel-root/logs
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.haniel.runner.plist 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.haniel.runner.plist
launchctl print gui/$(id -u)/com.haniel.runner | head -40
```

이전 macOS에서는 `launchctl load -w ~/Library/LaunchAgents/com.haniel.runner.plist`와 `launchctl unload`를 써도 된다. `KeepAlive`가 켜져 있으므로 프로세스를 종료해도 launchd가 다시 띄운다.

## 3. soul-server 구성

`haniel.macos.example.yaml`의 `repos`, `services`, `install.configs` 조각을 운영 `haniel.yaml`에 복사하고 계정 이름과 경로를 실제 값으로 바꾼다. 서비스 이름은 `soulstream-soul-server-ts`이고 `post_pull`은 `bash src/soulstream/deploy/haniel/build-core.sh`를 부른다.

필수 환경 변수는 `.env.soul-server-ts`에 둔다.

- `SOUL_RUNNER_PROCESS_ENABLED=true`
- `SOUL_RUNNER_STATE_DIR=/tmp/ss-run`처럼 짧은 절대 경로. 서비스 계정이 읽기, 쓰기, 실행 권한을 가진다
- `SOUL_RUNNER_ARTIFACT_DIR`, `SOUL_RUNNER_RELEASES_DIR`. live checkout 밖의 절대 경로
- `PORT`, `MCP_INTERNAL_PORT`는 `PORT + 1` 충돌 여부를 먼저 실측한다
- `PATH` 계열은 plist의 `EnvironmentVariables`가 정본이다. 서버 코드는 전역 `process.env.PATH`를 재작성하지 않는다

러너가 켜져 있으면 기동 시 `node:sqlite` 프로브를 통과해야 한다. 점검 스크립트가 같은 프로브를 미리 수행한다.

## 4. 빌드 훅

`build-core.sh`는 `set -euo pipefail` 직후 `uname -s`가 `Darwin`이면 `build_core_darwin.py`로 `exec`한다. Linux 훅은 GNU `realpath`, `flock`, `free`, GNU `timeout`과 `/home/eias` 고정 계정에 의존하므로 macOS에서 그대로 돌지 않는다.

Python 실행기는 Linux 훅과 같은 일을 한다.

- 기존 여섯 빌드 명령을 같은 순서와 인자로 실행한다. 두 번째 명령에는 `SOULSTREAM_RELEASE_ENV_FILE=<app>/.env.soul-server-ts`를 넘긴다
- 단계마다 `vm_stat`의 free, inactive, purgeable 합이 2000 MiB 이상인지 확인하고, 부족하면 60초 한 번 대기한 뒤 재확인하고 그래도 부족하면 종료 코드 1로 끝낸다
- `/tmp/soulstream-heavy-verify.deploy.lock` 배포 빌드 잠금을 전체 파이프라인 동안 잡는다. 에이전트 검증의 host heavy-verify gate는 잡지 않는다
- 단계 타임아웃은 900초이고, 타임아웃과 신호에는 프로세스 그룹에 SIGTERM을 보내고 최대 2초 뒤 SIGKILL한다
- 마지막에 다섯 산출물 파일의 존재를 확인한다

전제는 Python 3.11 이상이 서비스 PATH에 있는 것이다. macOS 빌드는 그 Mac에서 수행하며, 다른 OS의 release manifest나 산출물을 복사해 배포하지 않는다.

## 5. 락 파일 운영 주의사항

다음 세 파일은 지워서는 안 된다. 수동 삭제도, cron이나 `periodic` 스크립트로 거두는 청소도 하지 않는다.

- `/tmp/soulstream-runner-lock-<uid>-<sha256>.sqlite`: Darwin 러너 커널 락이다. SQLite EXCLUSIVE 잠금을 파일에 걸어 state 디렉토리 소유를 판정하며, 파일은 해제 시점에도 unlink하지 않는 것이 설계다. 잠금을 쥔 채 파일을 지우면 기존 inode의 잠금과 새 inode가 갈라져 두 호스트가 같은 state 디렉토리를 소유한다고 믿을 수 있다
- `/tmp/soulstream-heavy-verify.lock`: 호스트 heavy 작업 게이트다. 공통 heavy-work runner가 쓴다
- `/tmp/soulstream-heavy-verify.deploy.lock`: 배포 빌드 잠금이다. Linux 빌드 훅은 300초까지만 기다리고 못 잡으면 종료 코드 1로 끝나며, Darwin 실행기는 이 파일을 잡은 채 파이프라인을 돌아 프로세스가 끝날 때 함께 풀린다

남아 있는 빈 파일은 잠금이 아니므로 그 자체로 문제가 되지 않는다. 잠금 이상이 의심되면 파일을 지우지 말고, 그 락을 쥔 프로세스가 살아 있는지 확인한다.

`SOUL_RUNNER_STATE_DIR`을 지우는 것도 같은 이유로 금지한다. 러너 세션 상태와 SQLite, socket이 그 안에 있다.

## 6. 실기기 미확인

이 배선은 Linux에서 스크립트 점검과 단위 테스트로만 확인했다. 실제 Mac에서 launchd 등록, Haniel 기동, `node:sqlite` 플래그 없는 로드, `/tmp`와 `/private/tmp` 표기, 실제 `vm_stat` 출력 파싱, 빌드 산출물의 release manifest가 `platform=darwin`인지는 아직 확인하지 않았다. 새 노드를 세울 때 위 점검 스크립트와 빌드 한 번으로 확인한다.
