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

1. 노드 이름(기본 호스트명)과 회사 PC 여부(기본 아니오)를 묻습니다.
2. 화면에 나온 참여 코드를 관리자에게 알려 승인을 받습니다.
3. Codex 로그인이 안 되어 있으면 기기 인증으로 안내합니다.
4. Claude 계정은 실행기가 로그인하지 않습니다. 기존 대시보드에서 이 노드의 계정 로그인 위치를 열어 등록합니다.

## 상태와 판 맞춤

모든 상태는 `portable-node/.state/`에 있습니다. 이 폴더를 지우면 참여부터 다시 합니다. 소스는 오케스트레이터가 가리키는 커밋으로 자동으로 맞춰지므로 `git pull`을 직접 하지 마세요. 작업 트리에 변경이 있으면 판 전환을 보류하고 알립니다.

## 알아둘 것

이 노드에서는 push와 PR을 할 수 없습니다.

macOS에서 Claude 로그인 자격 증명은 Keychain에 저장되어 `.state/`를 지워도 남을 수 있습니다. 완전히 지우려면 키체인 접근 앱에서 해당 Claude Code 항목을 삭제하세요.
