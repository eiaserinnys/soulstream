# Delivery와 실행 턴의 불변식

기준 커밋은 `9a0cb300`이다. 이 문서는 A(유실), B(중복), C(순서 역전), D(접수 성공의 거짓 실패)를 네 개의 독립 패치로 다루지 않는다. 공통 원인은 delivery가 대상 세션만 알 뿐, 그 메시지를 받기로 한 **구체적인 실행 턴**과 연결되지 않는다는 점이다.

이 문서는 구현안을 정하지 않는다. 다음 재설계가 만족해야 하는 관찰 가능한 계약과, 현재 구조가 그 계약을 증명할 수 없는 위치만 고정한다.

## 용어

- **논리 메시지**: 사용자가 한 번 보낸 의미 단위. 네트워크 재시도나 API 재호출로 새 의미 단위가 되지 않는다.
- **delivery**: 논리 메시지를 대상 세션에 전달하고 소비 사실을 기록하는 내구 레코드.
- **실행 턴**: 대상 세션에서 하나의 입력 집합을 소비해 하나의 엔진 실행으로 이어지는 구체적인 실행 명령. 세션이나 러너 프로세스의 존재와 구별한다.
- **접수**: 시스템이 논리 메시지의 이후 전달 책임을 내구적으로 인수한 상태.
- **소비**: 실행 턴이 논리 메시지를 입력으로 확정해 다시 소비해서는 안 되는 상태.

## 재설계 불변식

1. 접수된 논리 메시지는 사용자가 다시 보내지 않아도 대상 세션의 다음 유효한 실행 턴에 도달해야 한다. 일시적인 노드·러너·소유권 실패와 재시도 횟수 소진은 폐기 사유가 아니다.
2. delivery의 모든 전달 시도는 하나의 구체적인 실행 턴에 귀속되거나, 아직 어떤 턴에도 귀속되지 않은 대기 상태로 명시되어야 한다. `session.status`, 러너 존재, 노드 heartbeat만으로 귀속이나 소비를 추정하지 않는다.
3. 같은 논리 메시지는 최대 한 번 소비된다. 이미 소비된 delivery의 receipt는 영구적인 tombstone이며, 재시작·재연결·타임아웃 뒤에도 새 실행 턴에 다시 투입되지 않는다.
4. 판정할 수 없는 이전 시도가 있으면 새 시도를 맹목적으로 만들지 않는다. 먼저 이전 실행 턴의 receipt를 화해하고, 이전 턴이 소비하지 않았음이 증명된 뒤에만 delivery를 다른 실행 턴에 귀속한다.
5. 같은 대상 세션의 delivery는 내구 enqueue 순서로 소비된다. 선행 delivery가 소비되거나 명시적으로 거절·취소·대체되기 전에는 후행 delivery가 먼저 실행 턴에 귀속되거나 소비될 수 없다.
6. 새로운 유효 실행 턴의 활성화는 그 세션에 남아 있는 미결 delivery의 화해·재전달 트리거다. 시간 기반 폴러나 프로세스 재시작만이 회수 주체여서는 안 된다.
7. attempt 예산은 활성 재시도 cadence를 제한할 뿐 delivery의 책임을 없애지 않는다. 예산 소진 뒤에도 delivery는 회수 가능한 상태와 명시적인 회수 주체를 가진다.
8. durable queue 등재나 동일한 접수 receipt가 확인되면 호출자에게 접수 성공을 반환한다. CAS miss나 응답 타임아웃만으로 실패를 반환하지 않는다.
9. 실패는 시스템이 접수 책임을 인수하지 않았음이 증명된 경우에만 반환한다. 결과가 불명확하면 `uncertain`을 반환하되, 그 상태는 화해 작업이 남아 있다는 뜻이며 종착지가 아니다.
10. delivery의 성공·실패·미결 판정은 세션 전체의 생존이 아니라 귀속된 실행 턴의 명령·receipt·종결 사실으로 결정한다.

## `uncertain` 의미 분리

현재 `uncertain`은 서로 다른 두 사실을 한 상태로 표현한다. 재설계에서는 적어도 의미상 다음 둘을 구별해야 한다. 실제 타입명이나 저장 형식은 이 문서의 범위가 아니다.

### 결과 미확정

- 뜻: 특정 실행 턴에 보냈으나 그 턴이 소비했는지 아직 증명하지 못했다.
- 허용 동작: 귀속된 실행 턴의 receipt와 종결 사실을 화해한다.
- 금지 동작: 같은 논리 메시지를 즉시 다른 실행 턴에 다시 투입하거나 폐기한다.
- 종착: 기존 실행 턴의 소비 receipt가 확인되면 `consumed`; 소비 없이 끝났음이 증명되면 미귀속 대기로 돌아가 다음 유효 실행 턴에 귀속; 명시적 정책 거절이면 `rejected`.

### 활성 재시도 중지

- 뜻: 재시도 cadence 또는 연속 실패 상한을 소진해 지금은 적극적으로 밀지 않지만, 전달 책임은 남아 있다.
- 허용 동작: 새 실행 턴 활성화, 소유권 교체, 운영자 회수 같은 명시적 트리거를 기다린다.
- 금지 동작: `dead_letter`와 동치로 취급하거나 영구 미스캔한다.
- 종착: 이후 실행 턴에서 `consumed`, 사용자의 명시적 취소·대체, 또는 시스템이 정의한 명시적 영구 거절. 횟수 소진 자체는 종착이 아니다.

## A·B·C·D가 구조적으로 불가능해지는 이유

| 결함 | 구조적 차단 조건 | 상설 회귀 시나리오 |
|---|---|---|
| A 유실 | 미결 delivery가 구체적인 실행 턴과 화해되고, 새 실행 턴 활성화가 회수 트리거이며, attempt 소진이 책임 소멸이 아니다 | `delivery-revival` |
| B 중복 | 논리 메시지 identity와 소비 tombstone이 재시도 전 구 execution receipt와 화해되어 한 번만 소비된다 | `delivery-exact-once` |
| C 순서 역전 | 같은 대상의 실행 턴 귀속이 enqueue 순서에 의해 직렬화되고 선행 미결 delivery가 후행을 막는다 | `delivery-fifo` |
| D 거짓 실패 | API 결과가 마지막 CAS 반환값이 아니라 내구 접수 receipt로 결정된다 | `delivery-accepted-cas` |

## 현재 구조가 불변식을 보장할 수 없는 지점

아래 줄은 기준 커밋 `9a0cb300`의 파일 위치다.

1. `packages/db-schema/sql/schema.sql:330-380`의 `session_deliveries`에는 대상 세션과 enqueue 순서는 있지만 실행 명령·실행 generation·실행 receipt를 가리키는 필드가 없다. 반면 실행 정본인 `session_execution_ownerships.execution_command_id`는 같은 파일 `2470-2518`에 별도로 존재한다. 두 aggregate 사이의 관계를 질의할 수 없다.
2. `orch-server-ts/src/control_plane/control_plane_types.ts:25-80`의 row와 등록 입력 타입도 실행 턴 identity를 표현하지 않는다. 타입 수준에서 “어느 실행이 이 delivery를 받았는가”를 답할 수 없다.
3. `orch-server-ts/src/control_plane/repositories/session_delivery_relation_repository.ts:55-80`은 target session과 논리 identity만 등록한다. 실행 턴 귀속은 생성 시점에도 남지 않는다.
4. `orch-server-ts/src/control_plane/repositories/session_delivery_repository.ts:104-127`의 claim은 target session 존재만 확인한다. 현재 실행 명령과 연결하거나 선행 delivery를 fence하지 않는다.
5. `orch-server-ts/src/control_plane/repositories/session_delivery_recovery_repository.ts:90-145`의 pending scan은 `state='pending'`과 due time만 보고 claim한다. `uncertain`은 스캔 대상이 아니며, 정렬도 `next_attempt_at`이 enqueue 순서보다 앞서 C를 보장하지 못한다.
6. 같은 파일 `244-315`의 queued recovery는 node startup, heartbeat, queued age로 회수 여부를 정한다. 새 실행 턴 활성화와 delivery 사이의 관계를 확인하지 않으므로 살아난 실행이 기존 queued delivery를 반드시 회수한다는 증명이 없다.
7. `orch-server-ts/src/control_plane/repositories/session_delivery_retry_policy.ts:74-93`은 횟수·나이 소진을 `state='uncertain'`과 `aggregate_state='dead_letter'`로 동시에 만든다. “결과를 아직 모름”과 “활성 cadence를 멈춤”이 한 표현에 섞이고, recovery 정본에서 제거된다.
8. `orch-server-ts/src/control_plane/repositories/session_delivery_repository.ts:282-305`는 durable admission을 기록하지만, `soul-server-ts/src/task/task_delivery_ledger_gate.ts:218-241`은 동일 row가 이미 queued로 전진한 CAS miss를 재조회하지 않고 예외로 보고한다. 접수 성공이 503으로 바뀌어 호출자 재전송을 유발한다.
9. `soul-server-ts/src/task/task_delivery_ledger_gate.ts:248-274`와 `283-320`은 실행 receipt를 화해하지 않은 채 attempt 수로 retry와 `uncertain` 종결을 가른다.
10. `soul-server-ts/src/task/completion_delivery_coordinator.ts:228-273`은 dispatch 예외가 난 실행 턴의 실제 접수 여부를 확인하지 않고 재시도하거나 terminal `uncertain`으로 보낸다. B와 A 중 어느 쪽을 택했는지 증명할 정보가 없다.
11. `soul-server-ts/src/task/task_intervention_route.ts:343-380`은 retry 예산 소진을 HTTP 실패로 승격한다. durable 접수 여부와 분리되지 않아 D가 B의 재전송 방아쇠가 된다.
12. `orch-server-ts/src/control_plane/repositories/session_delivery_repository.ts:308-351`의 delivered·consumed receipt는 caller turn 문자열만 남긴다. 그 turn이 어떤 execution command의 결과인지 연결되지 않아 재시작 경계의 화해 근거가 불완전하다.

## 회귀 게이트 판정

- 네 시나리오는 현재 코드에서 RED여야 한다. 재설계 완료의 최소 조건은 네 시나리오가 제품 우회나 수동 DB 정리 없이 모두 GREEN인 것이다.
- 단순히 delivery 최종 state만 보지 않는다. 각 시나리오는 사용자 메시지 수, assistant marker 수, 소비 row 수, enqueue 순서를 함께 판정한다.
- `delivery-revival`은 사용자 재전송 없이 회수되어야 한다.
- `delivery-exact-once`는 같은 논리 identity를 두 번 제출해도 사용자 입력과 실행 결과가 각각 한 번이어야 한다.
- `delivery-fifo`는 due time을 역전시켜도 enqueue 순서로 소비되어야 한다.
- `delivery-accepted-cas`는 DB row가 먼저 queued로 전진한 CAS race에서 API가 실패를 반환하지 않고, 사용자 입력이 한 번만 소비되어야 한다.
