# 실행 중인 턴 재설계 불변식과 RED 게이트

## 목적과 범위

이 문서는 업무 `02fe8079`·`d38daa1d`에서 확인한 한 가지 구조 결함을 재설계의 입력으로 고정한다. 현재 시스템에는 “지금 실행 중인 턴”을 수명주기와 함께 소유하는 1급 표현이 없다. 그 결과 러너가 사라진 뒤에도 호스트 대기가 남는 결함과, 활성화 전 스폰을 되돌릴 때 자식이 남는 결함이 서로 다른 경로에서 발생한다.

이 문서는 구현안을 정하지 않는다. 랩의 영구 RED 시나리오, 올바른 구조가 지켜야 할 불변식, 현재 구조가 그 불변식을 보장할 수 없는 코드 근거만 기록한다. delivery 재전달은 업무 `89e99d25`의 범위이며 여기서 다루지 않는다.

기준 커밋은 `9a0cb300`이다.

## 영구 RED 시나리오

### runner-death-live-host

1. 90초 도구 호출을 수행하는 세션을 만들고 active ownership과 호스트 `activeRunnerOperations` 관측을 모두 확인한다.
2. 호스트는 살려 둔 채 러너에 `SIGTERM`을 보내고 실제 프로세스 종료를 확인한다.
3. 러너 등록 디렉터리를 숨겨 등록 소멸을 재현한다.
4. 재시작·reserve·intervention 없이, 다음 호스트 관측에서 그 세션의 active operation이 사라지고 세션이 terminal로 수렴하기를 기다린다.
5. 4가 끝난 뒤에만 intervention을 보내 새 PID의 러너가 답을 정확히 한 번 내는지 확인한다.

현재 코드는 4에서 빨개져야 한다. 회수가 새 reserve나 intervention에서 우연히 일어난 결과는 통과가 아니다.

### activate-rollback

1. ownership이 `identity_proven`에 도달한 뒤 `active` 전이를 지연시키고 실패시키는 랩 트리거를 건다.
2. 그 사이 `runner.pid`에 별개의 살아 있는 PID를 써서 실제 사고의 충돌 증거를 재현한다.
3. 정확히 이번 시도에서 스폰한 자식이 15초 안에 죽는지 확인한다.
4. 세션은 `error`, 거절된 generation은 terminal로 수렴해야 한다.
5. 한 재시도 간격 뒤에도 open phase와 `orphaned_spawn` generation이 없어야 한다.

현재 코드는 3에서 `activate rollback left the spawned child live`로 빨개져야 한다.

두 시나리오는 `fault-harness.sh scenario <id>`로 단독 실행할 수 있고, canonical `all` 순서의 첫 두 항목으로 상설 등록한다.

## 재설계 불변식

### 실행 정체성과 상태

1. 세션에는 최대 하나의 현재 실행 턴만 존재한다. 러너, ownership generation, command, frame stream, 호스트 대기, 진단 관측은 모두 같은 실행 정체성을 가리킨다.
2. 실행 상태는 명시적인 하나의 상태 기계다. 필드 여러 개의 존재 여부 조합으로 상태를 추론하지 않는다.
3. provisional spawn도 실행 턴이다. spawn 순간부터 PID 재사용을 구분할 수 있는 자식 정체성과 ownership generation을 잃지 않는다.
4. 실행 정체성이 교체되면 이전 실행의 어떤 자원·대기·관측도 새 실행에 붙을 수 없다.

### 종료와 대기 정산

5. 러너 프로세스가 사라지거나 그 실행의 등록이 사라지면, 그 실행을 붙든 모든 대기는 제한 시간 안에 반드시 성공 또는 실패로 settle된다.
6. 5의 회수는 호스트 재시작, 새 reserve, intervention, delivery 재시도에 의존하지 않는다. 아무도 다시 메시지를 보내지 않아도 스스로 실행을 닫는다.
7. 실행을 가리키는 필드를 비우거나 핸들을 버리는 행위는 실행 종료가 아니다. 실행은 frame stream, execution promise, request lifetime, ownership, host resource, 진단 operation이 모두 같은 terminal transition을 관찰한 뒤에만 사라진다.
8. terminal transition은 멱등이며 정확히 한 번의 사용자 가시 결과로 수렴한다. 같은 실행의 종료 신호가 여러 경로에서 와도 중복 완료·중복 실패·영구 대기가 생기지 않는다.
9. 현재 실행이 끝나면 그 실행의 `activeRunnerOperations` 관측도 함께 끝난다. 진단 정보가 실제 실행 수명보다 오래 남을 수 없다.

### 활성화 실패와 rollback

10. 활성화에 실패한 provisional spawn은 둘 중 하나로만 수렴한다. 같은 generation이 활성 실행이 되거나, 그 시도가 만든 정확한 자식의 사망을 증명한 terminal 실패가 된다.
11. 활성화 실패 뒤 살아 있는 자식, open ownership, 도달 불가능한 대기를 남기는 제3의 상태는 허용하지 않는다.
12. rollback 대상은 그 시도가 스폰하며 확보한 정확한 자식 정체성이다. 다른 시점의 pid 파일·lifecycle·registration 잔재가 충돌해도 이 자식의 회수를 막을 수 없다.
13. 자식 회수의 첫 시도가 실패해도 상태 기계는 제한된 재시도 또는 명시적 terminal 책임 상태로 전진한다. 같은 ownership conflict를 무한 재시도하며 사람이 PID를 죽이기를 기다리지 않는다.

### 회수와 관측

14. 실행 회수기는 등록 디렉터리 inventory와 별개로 현재 실행 턴 inventory를 주기적으로 대조한다. 등록 행이 0개인 것은 회수할 실행이 0개라는 뜻이 아니다.
15. 실행 획득과 해제는 대칭인 하나의 경계에서 수행한다. 획득한 모든 자원의 해제 책임과 순서는 그 경계가 소유한다.
16. 실행의 durable 상태, 프로세스 생사, 메모리 상태가 어긋나면 어느 generation을 terminalize할지 하나의 결정표로 정한다. 각 호출자가 일부 필드를 직접 비우며 독자적으로 복구하지 않는다.

## 현재 구조가 보장하지 못하는 이유

| 불변식 | 코드 근거 | 보장 불가 이유 |
|---|---|---|
| 1~4 | `soul-server-ts/src/task/task_models.ts:384` | 현재 실행은 `runner`, reservation, ownership, terminal fact, recovered identity, promise, activation handoff 등 서로 독립적인 optional 필드 묶음이다. 하나의 discriminated state가 아니므로 불가능한 조합도 표현된다. |
| 5~9 | `soul-server-ts/src/task/task_executor.ts:365` | `executionPromise`는 Task 필드에 저장되고 그 promise 자체가 settle될 때만 callback이 필드를 비운다. 러너 생사와 연결된 종료 소유자가 없다. |
| 5·7 | `soul-server-ts/src/runner/runner_process_frame_stream.ts:40` | frame stream은 `finish()` 또는 `fail()` 호출이 없으면 54행의 waiter에서 무기한 기다린다. 프로세스·등록 소멸을 관찰하는 경계가 없다. |
| 6·14 | `soul-server-ts/src/runner/runner_recovery_coordinator.ts:161` | recovery scan의 입력은 `scanRunnerRegistrations()` 결과뿐이다. 등록이 사라지면 그 세션은 admitted loop에 들어오지 않아 in-memory execution을 회수할 트리거가 소멸한다. |
| 7·15·16 | `soul-server-ts/src/runner/runner_recovery_coordinator.ts:431` | offline 경로는 `task.runner`와 `task.executionPromise`를 직접 비운 뒤 `detachHost()`를 호출한다. 필드 참조 제거와 실제 stream/promise settlement가 서로 다른 연산이다. |
| 6 | `soul-server-ts/src/runner/runner_recovery_coordinator.ts:465` | 등록이 보이는 동안에도 `task.runner` 또는 `task.executionPromise`가 있으면 recovery를 건너뛴다. 사고에서 `blockedBy: execution_promise`가 반복된 바로 그 게이트다. |
| 7·15 | `soul-server-ts/src/task/task_executor.ts:1666` | runner 획득은 `attachRunner()`로 묶였지만 대응하는 단일 release 연산이 없다. 여러 복구 경로가 `task.runner`와 promise를 따로 비운다. `task_runner_recovery.ts:43`과 `task_runner_recovery.ts:85`에도 같은 부분 해제가 있다. |
| 7~9 | `soul-server-ts/src/runner/runner_process_dispatcher.ts:313` | `close()`는 request와 호스트 자원을 닫지만 active stream terminalization을 명시하지 않는다. `detachHost()`도 370행에서 같은 부분 동작을 한다. |
| 7~9 | `soul-server-ts/src/runner/runner_process_dispatcher.ts:942` | active stream `fail()`과 active command clear는 reconnect budget 소진 경로에만 함께 있다. 모든 종료 원인이 통과하는 canonical terminal transition이 아니다. |
| 9 | `soul-server-ts/src/runtime/node_stall_monitor.ts:118`, `soul-server-ts/src/runner/runner_process_dispatcher.ts:1266` | 진단 operation은 dispatcher가 받은 finish callback을 호출해야만 Map에서 삭제된다. 러너 생사나 ownership terminal 상태와 직접 결합되지 않는다. |
| 3·10 | `soul-server-ts/src/task/task_executor.ts:472` | spawn·attach·prove·activate가 순차 실행되고 proof는 지역 변수로만 유지되다가 activate 성공 후 531행에서야 Task ownership이 된다. 활성화 전 실행을 대표하는 단일 객체가 없다. |
| 10~12 | `soul-server-ts/src/runner/runner_process_dispatcher.ts:254`, `soul-server-ts/src/runner/runner_process_spawn.ts:337` | dispatcher는 정확한 proof를 갖고도 generic spawner termination으로 넘긴다. spawner는 380행부터 등록·lifecycle·pid 파일을 다시 합성한다. |
| 12 | `soul-server-ts/src/runner/runner_process_registration.ts:16` | PID 후보가 다르고 하나라도 살아 있으면 30행에서 즉시 `runner pid evidence disagrees`로 실패한다. 따라서 정확히 스폰한 자식 proof가 stale sidecar보다 우선하지 못한다. |
| 11·13 | `soul-server-ts/src/task/task_executor.ts:574` | rollback 실패는 `RunnerOrphanedSpawnError`로 바뀌고 612행부터 ownership을 orphan으로 투영한 뒤 Task의 runner 참조만 버린다. 살아 있는 자식과 충돌 원인은 남는다. |

## 기준 RED 증거

기준 `main 9a0cb300`에서 랩 명령은 다음 두 개다.

```bash
/home/eias/services/soulstream-lab/repo/scripts/lab-node/fault-harness.sh scenario runner-death-live-host
/home/eias/services/soulstream-lab/repo/scripts/lab-node/fault-harness.sh scenario activate-rollback
```

260823 실측 결과:

```text
scenario-runner-death-live-host-2026-08-23T05-23-20-918Z
status: failed
failure: node log did not report missing runner execution settled without host restart
settlementLogCount: 0
new invariant: unanswered_demand=1

scenario-activate-rollback-2026-08-23T05-26-54-357Z
status: failed
failure: activate rollback left the spawned child live
runner pid: 2361724
ownership generation: 265270288585152
```

첫 실행 당시 판정은 수리 초안 전용 로그를 기다렸지만, 보존한 최종 시나리오는 그 문구를 제거했다. 대신 fault 전후 `activeRunnerOperations` 상태 전이를 직접 판정한다. 이전 RED의 `settlementLogCount=0`과 `unanswered_demand=1`이 나타낸 영구 대기를 구현 독립적인 관측으로 고정한 것이다.

## 재설계 통과 조건

- 두 fault 시나리오가 단독 실행과 canonical `all`에서 모두 초록이다.
- `runner-death-live-host`는 재시작·reserve·intervention 전에 active operation 부재와 terminal session을 먼저 증명한다.
- `activate-rollback`은 정확한 자식 사망, terminal ownership, open/orphan generation 부재를 모두 증명한다.
- 기존 fault 시나리오와 mutation 판정기가 그대로 통과한다.
- 통과 근거는 시나리오 result와 보존 evidence이며 “에러 0건”만으로 완료하지 않는다.
