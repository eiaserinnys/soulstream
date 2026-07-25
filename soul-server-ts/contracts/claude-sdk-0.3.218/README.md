# Claude SDK 0.3.218 실제 계약 측정

`scripts/claude_sdk_contract_harness.ts`는 프로덕션 서비스와 분리된 임시 작업 디렉터리에서 실제
`@anthropic-ai/claude-agent-sdk` 0.3.218과 Claude Code 바이너리를 실행한다.

측정 범위:

- 하나의 streaming `Query`가 여러 foreground `Result` 뒤에도 열려 있는지
- `interrupt()` receipt와 interrupted `Result`의 순서
- UUID가 부여된 다음 턴 메시지가 `still_queued`에 포함되고 정확히 한 번 실행되는지
- 진행 중 Bash를 `backgroundTasks(toolUseId)`로 넘긴 뒤 foreground `Result`,
  `background_tasks_changed`, `task_notification`이 어떻게 관측되는지
- `Query.close()`가 iterator와 subprocess를 끝내는지

## 설계 가정을 뒤집은 실측

- 로컬 input queue에 UUID 메시지를 넣은 뒤 `interrupt()`를 호출하면 receipt의
  `still_queued`는 비어 있어도 해당 UUID는 다음 턴에서 정확히 한 번 실행됐다.
  따라서 receipt만 정본으로 삼지 않고 로컬 delivery ledger와 합쳐 판정해야 한다.
- interrupt 뒤 foreground `Result`는 정상 완료가 아니라
  `error_during_execution` / `aborted_streaming`으로 도착했다. 이 조합은 사용자 오류로
  승격하지 않고 계획된 interrupt의 turn 종료 edge로 처리해야 한다.
- 명시적으로 background된 Bash는 foreground `Result` 뒤에도 살아 있었고, 이후
  `background_tasks_changed`의 빈 replace-set과 `task_notification`이 도착했다.
  foreground `Result`에서 `Query.close()`를 호출하면 이 tail을 잘라낸다.
- `backgroundTasks(toolUseId)`는 이미 background된 task에는 `false`를 반환했다.
  설계는 tool-use 시점의 즉시 제어 성공에 의존하지 않는다.
- 이 실행에서는 `session_state_changed`가 관측되지 않았다. 상태기계의 필수 latch로
  사용하지 않는다.

산출물:

- `raw-events.jsonl`: 메시지 본문·명령·로컬 경로를 제외한 구조적 실제 이벤트 로그
- `assertions.json`: 설계가 의존하는 정규화 계약과 통과 여부

실행:

```bash
pnpm --dir soul-server-ts contract:claude-sdk
```

이 harness는 실제 Claude 계정 인증과 모델 호출을 사용한다. 일반 단위 테스트에는 포함하지 않으며,
SDK 또는 Claude Code 버전을 변경할 때 명시적으로 다시 실행한다.
