# 공용 스킬 스크립트 번들

설치기가 이 폴더의 파일을 `<설치 루트>/.local/agent-common/`으로 복사하고, 워커의 `AGENT_COMMON_FILES_DIR`가 그 폴더를 가리킨다. 스킬 본문은 atom이 정본이고, 스킬이 부르는 스크립트와 자산은 `$AGENT_COMMON_FILES_DIR/skills/<스킬명>/`에서 읽는다.

## 들어 있는 것

- `skills/html-make/scripts/check-ui-css.mjs`: HTML 문서용 CSS 검사기. 저장소의 `scripts/check-ui-css.mjs`와 같은 파일이다.
- `skills/html-make/scripts/ui-css-check.config.json`: 검사 기준 설정.

## 커스텀 스킬 스크립트를 두는 법

- 폴더 하나에 스킬 하나: `$AGENT_COMMON_FILES_DIR/skills/<스킬명>/`. 외부 패키지가 필요 없는 Node `.mjs`를 우선한다.
- 번들이 설치하는 파일(위 목록)은 설치기가 다시 실행될 때 덮어쓴다. 같은 경로를 고치지 말고 별도 이름의 스킬 폴더를 만든다.
- 사용자가 더한 폴더와 파일은 다시 설치하거나 업데이트해도 지우지 않는다.
- 임시 스크립트는 작업공간의 `.local/tmp`, 산출물은 `.local/artifacts`에 둔다.
