# Soulstream 상태 머신 inventory

기준 commit: `1f15e59e3747fc5de5e245babf16753cce8a7367`.

앱에서 확인한 **13개 주요 책임 경계**다. 전체 코드의 모든 상태 머신을 빠짐없이 추출했다는 의미는 아니다. 전달의 6개 내부 상태층을 별도 subsystem으로 세어 숫자를 부풀리지 않았다. `명시됨`은 enum/전이 함수/직접 상태 필드가 보인다는 뜻이고, `암묵 결합`은 여러 owner의 필드·콜백·receipt를 함께 읽어야 실제 상태가 정해진다는 뜻이다.

| 독립 경계 | 상태축 또는 코드에서 확인한 전이 | 주요 코드 위치 | 명시됨 / 암묵 결합 | 이번 검증 |
|---|---|---|---|---|
| 1. 세션 실행 수명 | initializing/running/completed/error/interrupted와 activation·execution registration·terminal fact | `soul-server-ts/src/task/task_models.ts`, `task_executor.ts` | lifecycle은 명시, 실제 프로세스·activation·정본 종료와의 조합은 암묵 | 소스 확인. 전체 실행 수명 검증은 안 함 |
| 2. runner 재시작 복구 | adopt/replay/reap/retire 판정; old/new 실행 identity; replay 완료 여부 | `soul-server-ts/src/runner/runner_process_registry.ts`, `runner_recovery_disposition.ts` | disposition은 명시, runner 생사·현재 실행 소유권·replay 간 결합 | 실제 함수 유한 입력 검사 + TLA+의 두 보호조건 검증 |
| 3. 실행 중 개입과 다음 턴 큐 | live 전달 / next_turn 대기 / deferred; high/low 큐; 단독 runtime follow-up | `soul-server-ts/src/task/task_running_intervention_transition.ts`, `task_intervention_queue.ts` | 반환 union·큐 조작은 명시, 현재 턴 종료·개입 순서와 결합 | 큐 2개 실제 함수의 유한 상태 전수검사. live 전달은 소스 조사만 |
| 4. 내구 메시지 전달·소비 | delivery 시도 상태 + aggregate 결과 + runner inbox ambiguity + 턴 receipt | `soul-server-ts/src/task/delivery_contract.ts`, `task_delivery_turn_receipt.ts`, `soul-server-ts/src/runner/sqlite_intervention_inbox.ts` | 각 층 상태는 명시, 접수/실제 소비/재전달 허가의 결합은 암묵 | 소스 확인. end-to-end exact-once 및 장애 복구 미검증 |
| 5. 이벤트 outbox→정본 저장→공개 | 로컬 보관, batch 전송, stream/sequence ACK, 정본 적용, 로컬 publish fence | `soul-server-ts/src/upstream/event_outbox_pump.ts`, `event_outbox_pump_protocol.ts` | sequence/ACK는 명시, 여러 비동기 단계의 공개 시점이 결합 | 이번 outbox 실제 코드 검사 및 좁은 TLA+ 모델 대상 |
| 6. 카드·폴더의 수동 업무 상태 | 카드 8상태(todo/queued/blocked/running/review/on_hold/done/cancelled), archive 별도, 폴더 open/completed | `orch-server-ts/src/cards/card_operations.ts`, `control_plane/card_mutation_core.ts`, `control_plane/card_types.ts` | 명시. 상태 간 자유 변경 정책, 실행 상태와 별개 | 소스 및 기존 자유전이 테스트 확인. 새 형식 검증 없음 |
| 7. 자동 worker 발사권·착수 확인 | admitted/launching/running/rejected, launch_accepted, launch deadline | `orch-server-ts/src/cards/card_orchestration_workers.ts`, `card_orchestration_repository.ts`, `card_work_lifecycle.ts` | 상태는 명시, 수락/착수/timeout/카드 version 결합 | 원본 class 25시나리오 + TLA+에서 중복 발사·수락 후 만료 거부 보호 검증 |
| 8. 카드 오케스트레이터 판단 조정 | reserved/judging/decided/completed/blocked/cancelled; lease owner; input hash; pending/dirty | `orch-server-ts/src/cards/card_orchestration_coordinator.ts` | run state는 명시, lease·dirty tick·모델 세션·정책 revision 결합 | 본문 확인. 변경된 논리 입력만 재판단, 불확실 create 재발사 금지 분기 확인. 검증 미실행 |
| 9. PAS 세대 교체 | 현재 generation, pending generation, applyingFrom, 새 backend session ID, resetContext/keepInstructions | `soul-server-ts/src/task/persistent_session_control.ts`, `persistent_generation_state.ts` | 별도 단일 enum보다 optional 필드 조합으로 전이가 암묵화 | 본문 확인. 다음 execution start 적용 및 이전 세대 복원 분기 확인. 검증 미실행 |
| 10. 도구 승인·재개 | 승인 대기 ID, hydrated task, queued decision, 승인 이벤트 기록, onResume | `soul-server-ts/src/task/task_tool_approval_recovery.ts`, `task_delivery_route.ts` | 외부 결과는 union, 대기/복원/승인/재개는 여러 필드·콜백의 조합 | 본문 확인. 실제 approval/재시작 동작 미검증 |
| 11. 앱 SSE 연결·재연결 | effect/auth scope generation, connection generation, background flag, retry count/timer, destroy | `soul-app/src/hooks/useSSEStream.ts` | 하나의 enum 없이 ref/closure/타이머로 결합된 전형적 암묵 상태 머신 | 본문 확인. 이전 연결 이벤트 fencing·401 종료·background 복귀 분기 확인. 검증 미실행 |
| 12. 예약 작업 run 수명 | queued/waiting_for_node/dispatching/awaiting_session/running/terminal; job enabled/version; scheduled/manual identity | `orch-server-ts/src/recurring-jobs/types.ts`, `run_lifecycle.ts` | run enum은 명시, job 중지/발사 claim/노드 관측 결합 | 타입·수명 함수 본문 확인. expected-source-state 저장 확인. scheduler/SQL 전체 미검토 |
| 13. 협업 Page 동기화 client | connecting/syncing/ready/reconnecting/disconnected/authentication_failed/destroyed + everSynced/pending mutations | `packages/soul-ui/src/page/page-yjs-client.ts` | status enum 명시, provider callback·ready/synced·정리 시점 결합 | client 본문 확인. 연결 성공≠동기화 완료 gate 확인. Yjs 서버/저장 경로 미검증 |

## 해석

소울스트림에는 이미 명시적 상태 타입과 전이 소유자가 많다. 핵심 위험은 상태 이름이 없다는 데 있기보다 **서로 다른 책임 경계의 상태를 같은 성공/완료로 오해하는 결합**에 있다. 예를 들면 카드 running이 프로세스 시작을 증명하지 않고, 메시지 queued가 소비를 증명하지 않으며, SSE open이나 Yjs connected가 화면의 정본 동기화 완료를 증명하지 않는다.

이번에 실제로 실행한 검증은 2·3·5·7의 좁은 속성이다. 나머지는 다음 모델 후보를 고르기 위한 코드 inventory이며 검증 완료로 표시하지 않는다. 특히 PAS generation, 승인 복원, SSE 재연결, 협업 편집의 전체 사용자 시나리오는 이번 검사의 빈 영역이다.

## 추가 직접 확인한 원본 링크

- [판단 coordinator](https://github.com/eiaserinnys/soulstream/blob/1f15e59e3747fc5de5e245babf16753cce8a7367/orch-server-ts/src/cards/card_orchestration_coordinator.ts)
- [PAS generation state](https://github.com/eiaserinnys/soulstream/blob/1f15e59e3747fc5de5e245babf16753cce8a7367/soul-server-ts/src/task/persistent_generation_state.ts)
- [PAS control](https://github.com/eiaserinnys/soulstream/blob/1f15e59e3747fc5de5e245babf16753cce8a7367/soul-server-ts/src/task/persistent_session_control.ts)
- [도구 승인 복원](https://github.com/eiaserinnys/soulstream/blob/1f15e59e3747fc5de5e245babf16753cce8a7367/soul-server-ts/src/task/task_tool_approval_recovery.ts)
- [앱 SSE](https://github.com/eiaserinnys/soulstream/blob/1f15e59e3747fc5de5e245babf16753cce8a7367/soul-app/src/hooks/useSSEStream.ts)
- [예약 run state](https://github.com/eiaserinnys/soulstream/blob/1f15e59e3747fc5de5e245babf16753cce8a7367/orch-server-ts/src/recurring-jobs/types.ts)
- [예약 run lifecycle](https://github.com/eiaserinnys/soulstream/blob/1f15e59e3747fc5de5e245babf16753cce8a7367/orch-server-ts/src/recurring-jobs/run_lifecycle.ts)
- [Page 협업 client](https://github.com/eiaserinnys/soulstream/blob/1f15e59e3747fc5de5e245babf16753cce8a7367/packages/soul-ui/src/page/page-yjs-client.ts)
