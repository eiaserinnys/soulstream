# 세션 삭제 경로

최종 대조 커밋 SHA: `126a0420406e8c7d368259499c44fb15faff83c5`

> 범위 주석: 삭제의 단일 owner는 `TaskLifecycleRoute.deleteTask`다. CatalogService는 중앙 row를 삭제하지 않고 삭제 완료 뒤 catalog projection만 발행한다. 과거 중앙-only 삭제 residue는 별도 scanner 없이 기존 15초 recovery scan과 시간당 GC가 수렴시킨다.

| 단계 | 파일:심볼(라인) | 이 단계가 소유한 사실 | 거부/분기 조건 |
| --- | --- | --- | --- |
| 1. MCP 진입 | `soul-server-ts/src/mcp/tools/catalog.ts:delete_session` (L382–400) | 삭제 전 board item id를 캡처하고 `TaskManager.deleteTask`를 호출한 뒤 catalog null delta를 멱등 발행한다. | lifecycle 삭제 실패는 error result로 올리고 catalog projection을 발행하지 않는다. 이미 없는 session은 stale catalog projection 정리를 위해 null delta를 다시 발행한다. |
| 2. evicted task hydration | `soul-server-ts/src/task/task_manager.ts:deleteTask` (L407–413), `task_evicted_hydration.ts:createEvictedTaskLoader` | 메모리 부재 local session도 DB row에서 Task로 복원해 같은 lifecycle route로 보낸다. | 중앙 row가 없으면 false no-op, 다른 node 소유면 owner mismatch로 거부한다. |
| 3. interrupt·drain | `soul-server-ts/src/task/task_lifecycle_route.ts:deleteTask` (L84–90), `task_lifecycle_transition.ts:interruptAndDrain` | 현재 runner handle을 먼저 고정하고 interrupt를 보낸 뒤 execution promise가 끝날 때까지 기다린다. | interrupt rejection은 기존 idempotent cleanup 정책으로 drain을 계속하지만 미종료 promise를 건너뛰지 않는다. |
| 4. runtime close | `soul-server-ts/src/task/task_lifecycle_route.ts:closeSessionRuntimeIfPresent` (L69–81), `deleteTask` (L90–98) | persistent Claude runtime을 `session_delete` 사유로 닫고, 이어서 캡처한 runner dispatcher를 닫는다. | runtime registry가 close 뒤에도 entry를 보유하거나 dispatcher close가 실패하면 중앙 row를 보존하고 실패한다. |
| 5. terminal registration retirement | `soul-server-ts/src/task/task_lifecycle_route.ts:deleteTask` (L99–107), `runner/runner_process_dispatcher.ts:retireTerminalRegistration` (L378–394), `runner_process_spawn.ts:retireTerminalRegistration` (L390–416) | process runner는 exact registration generation과 kernel lock을 검증해 `retiredAt` evidence로 전환한다. host-persisted in-process runner에는 durable registration이 없다. | process runner에 retirement capability가 없거나 registration generation이 바뀌거나 lock owner 종료를 증명하지 못하면 중앙 row 삭제 전에 실패한다. |
| 6. 중앙 삭제·wire | `soul-server-ts/src/task/task_lifecycle_route.ts:deleteTask` (L109–123), `catalog/catalog_service.ts:broadcastSessionDeletion` (L291–300) | registration retirement가 끝난 뒤 session mutation host가 row·cascade를 삭제하고 task map을 비운다. `session_deleted`와 catalog null delta가 각 기존 wire로 전파된다. | 중앙 삭제 실패면 task를 기억해 재시도를 허용한다. `session_deleted` 실패는 기존 부가 wire 격리 정책을 유지하고 catalog delta는 MCP 재호출로 멱등 복구한다. |
| 7. 과거 residue 자기치유 | `soul-server-ts/src/runner/runner_recovery_coordinator.ts:performScan` (L228–268), `runner_registration_control.ts:retireReleasedTerminal` | hydration 결과가 실제 missing이고 registration의 PID/start identity가 모두 비어 있으며 kernel lock이 free인 residue만 기존 released-terminal retirement로 보낸다. | hydration deferred/failed, 중앙 row 재등장, PID/start identity 잔존, live/unavailable lock은 기존 경고·복구 경로에 남긴다. |
| 8. GC 회수 | `soul-server-ts/src/runner/runner_session_gc.ts:collect` (L43–211), `runner_session_gc_scheduler.ts:RunnerSessionGarbageCollectionScheduler` | retention이 지난 retired·kernel-free evidence는 중앙 row 부재를 GC lock 안에서 두 번 확인한 뒤 directory를 제거한다. 삭제된 session은 의도적으로 폐기된 durable tail이므로 `final_ack_pending`·`durable_replay_pending` 보존 게이트를 적용하지 않는다. | 중앙 row가 존재·복원되거나 registration generation이 바뀌면 보존한다. unreadable evidence는 격리 로그 후 보존한다. |

계약 테스트: `soul-server-ts/tests/runner/r36_delete_session_lifecycle_lab.test.ts`가 active MCP 삭제와 과거 `1ed01abc` 형상 residue를 함께 시드해 runner 종료, exact 순서, 경고 0, retirement, retention 뒤 GC 회수를 한 종단에서 검증한다.

이 장을 갱신해야 하는 변경 부류: MCP `delete_session`·TaskManager/TaskLifecycleRoute 삭제·runner close/registration retirement·missing-session recovery·terminal session GC·삭제 wire 변경.
