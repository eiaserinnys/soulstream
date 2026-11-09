# portable-node

소울스트림 노드를 새 PC에서 실행하는 실행기입니다. Node, Claude, Codex, Python은 `runtime-lock.json`에 고정한 판을 `portable-node/.state/runtimes/`에 내려받아 쓰며 시스템에 설치하지 않습니다.

## 실행

```sh
git clone --depth 1 https://github.com/eiaserinnys/soulstream
cd soulstream
./portable-node/start.sh
```

Windows에서는 `portable-node\start.cmd`를 실행합니다. Git과 OS 기본 도구(curl·tar, Windows PowerShell·tar)만 미리 있으면 됩니다.

## 처음 한 번

1. 노드 이름(기본 호스트명)만 묻습니다. 노드 이름은 영문 소문자와 숫자, `-`만 쓴 2~63자여야 하고 첫 글자는 영문 소문자나 숫자여야 합니다.
2. 화면에 나온 참여 코드를 관리자에게 알려 승인을 받습니다.
3. Codex 로그인이 안 되어 있으면 기기 인증으로 안내합니다.
4. Claude 계정은 실행기가 로그인하지 않습니다. 기존 대시보드에서 이 노드의 계정 로그인 위치를 열어 등록합니다.

## 기본 설정

실행기는 `portable-node/config/`의 템플릿 네 파일을 이번 실행의 상태 경로와 MCP 포트로 채워 `.state/config/<generation>/`에 씁니다. 기본 설정에는 Claude(`claude-opus`)와 Codex(`codex-6.1-sol`) 두 에이전트와, 이 노드 자신의 soulstream MCP 하나만 있습니다. 다른 MCP 서버와 API 키는 오케스트레이터에서 받지 않으며, 오케스트레이터가 주는 것은 노드 자격 증명과 앱 묶음뿐입니다.

## 상태와 판 맞춤

모든 상태는 `portable-node/.state/`에 있습니다. 이 폴더를 지우면 참여부터 다시 합니다. 소스는 오케스트레이터가 가리키는 커밋으로 자동으로 맞춰지므로 `git pull`을 직접 하지 마세요. 작업 트리에 변경이 있으면 판 전환을 보류하고 알립니다.

에이전트 작업 폴더는 `portable-node/.state/workspace/`이며 없으면 빈 폴더로 만듭니다. 실행기는 리포를 받지 않습니다.

`start.sh`·`bootstrap.ps1`은 내려받은 Node를 `portable-node/.state/runtimes/node/<version>/<platform>/`에 두고 같은 폴더에 `.portable-runtime.json` 설치 기록을 남깁니다. 다른 버전이 필요하면 그 버전의 새 폴더에 설치하며, 실행 중인 폴더는 지우지 않습니다.

새 판 준비는 child를 멈추기 전에 구성·앱 묶음·런타임·바인딩까지 끝냅니다. 준비나 기동이 실패하면 마지막으로 기동에 성공한 판으로 되돌리고 새 판 갱신을 멈춥니다. 실행기가 스스로를 다시 띄우는 종료 코드(75)는 `start.sh`·`start.cmd`가 횟수 제한 없이 다시 실행하며, 같은 이유의 재진입이 반복되는지는 실행기가 판정합니다.

## 알아둘 것

macOS에서 Claude 로그인 자격 증명은 Keychain에 저장되어 `.state/`를 지워도 남을 수 있습니다. 완전히 지우려면 키체인 접근 앱에서 해당 Claude Code 항목을 삭제하세요.
