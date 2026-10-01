# 앱 UI 사용 로그 재개·검증 handoff

## 현재 상태

- 앱 구현 PR: #147, `feat/ui-usage-events-app`
- 앱 구현 커밋: `5f1ffebe99e4cc149e63a80e365b885ba26f5d2c`
- 서버·웹 정본 PR #936은 `4eed8eacb8c948fb832b60f56846ec6c3a048cb5`로 머지되었다.
- Haniel 배포는 `orch`와 `soulstream-soul-server-ts`가 함께 영향받아, 사용자에게 워커 재시작 시점을 확인할 때까지 보류한다.

앱이 호출하는 `/api/ui-events`는 아직 배포되지 않았다. 따라서 배포 전 `404`는 예상된 서버 미배포 상태이며, 이 앱 변경의 장애나 회귀로 판정하지 않는다. 수집기는 config 조회 실패 시 fail-closed로 멈추므로, 앱의 기존 화면·검색·메시지 기능을 막지 않는다.

## 구현 범위

- v1 API client와 인증된 앱 수명 host
- 설치 ID·앱 실행 ID·앱 버전·순번을 보존하는 제한 대기열, 최대 50건 배치, 사용자·서버 전환 시 폐기
- 휴대폰/태블릿의 화면·업무·세션·페이지 열기, 검색 실행/결과/선택, 푸시 알림, 활성/비활성
- 일반 `ChatBody` / `ChatComposer` / `useChatSendFlow`의 compose 시작·전송·결과·이탈·복귀
- 세션 해석의 사용자 조작 대기·오류

구조화 `ChatInputRequest` 등 다른 입력 표면은 이 PR의 범위가 아니다. 초안 원문·키 입력·좌표·다른 앱 활동은 수집하지 않는다. `compose_result.sessionEventId`는 실제 전송 응답에 있을 때만 보낸다.

## 보존된 검증 증거

기준 앱 커밋은 위 `5f1ffeb`이다.

- 변경 경로 targeted Jest: 9 suites / 84 tests 통과
- 수집기·태블릿 후속 변경 Jest: 3 suites / 21 tests 통과
- 최종 수집기 Jest: 1 suite / 7 tests 통과
- 단계 3 변경 경로 Jest: 5 suites / 27 tests 통과
- `npx tsc --noEmit` 통과
- 모든 무거운 검증은 가용 메모리 확인 후 `/tmp/soulstream-heavy-verify.lock` 아래에서 실행했다.

422 영구 거절 테스트는 의도적으로 collector 경고를 출력한다. 테스트 실패가 아니며, 해당 배치를 재시도 대기열에서 제거하는 동작을 검증한다.

## 단계 3 배선 검토·보완

- 인증 host가 config `enabled:true`를 받은 뒤 `app_active`를 실제 큐에 넣은 경우에만 현재 화면 snapshot을 요청한다. config 전의 navigation 이벤트는 `lastView`를 갱신하지 않으므로, 늦게 켜진 수집이 최초 화면을 영구히 놓치지 않는다.
- phone은 `NavigationContainer`의 실제 route state를 snapshot한다. 수집이 꺼진 구간의 이전 대상은 추정하지 않고 `from:null`로 남긴다. tablet은 `currentPlannerUsageTarget()`으로 현재 page/task/session 하나만 snapshot한다.
- 일반 이동은 phone `onStateChange` 또는 tablet planner helper 중 하나만 지난다. 대표 tablet task 열기에서 `view_open(task-1, from:daily:2026-09-21)` 한 건만 확인했다. `search_result_open`·`action_*`은 별도 사실이며 `view_open` 중복이 아니다.
- 실제 통합 검증은 인증 scope → 지연된 config → NavigationContainer ready → config enable → POST 순서를 통과한다. spy만으로 recorder를 판정하지 않고 실제 `UiUsageEvents` 대기열·POST batch에서 `app_active`와 최초 `view_open(Feed, from:null)` 한 건을 확인한다.
- 검색 `queryText`는 trim·클라이언트 절단 없이 입력 원문을 보내며, 500자 상한은 공통 규약대로 서버가 처리한다.

`clientSessionKey`의 실제 의미는 OS 프로세스 전체가 아니라 **인증 수집 scope 수명**이다. foreground 왕복은 같은 key를 유지하고 `app_inactive`/`app_active`로 남는다. 반면 JWT 값이나 서버 주소가 바뀌어 auth generation이 바뀌면 host가 다시 `start()`하여 새 key와 seq=1 경계를 만든다. 토큰 refresh가 실제로 generation을 바꾸는 경우도 이 경계에 포함되므로, 이를 절대적인 “앱 실행 1회”라고 과장하지 않는다.

`installId`는 새 영속 키 `soul-app.ui-events.install-id.v1`을 쓴다. 기존 `push.deviceId`는 `ensurePushRegistered()` 안에서 실기기·푸시 권한·등록 경로를 통과할 때만 생성되고 푸시 서버 등록/해제에 묶인다. 푸시를 허용하지 않은 설치에서도 안정적인 수집 ID가 필요하므로 재사용하지 않았다.

## 배포 뒤 최소 smoke

1. 배포와 워커 재시작이 끝난 뒤 인증된 앱에서 `GET /api/ui-events/config`가 v1 설정을 반환하는지 확인한다.
2. 테스트 계정으로 피드 열기 → 검색 실행·결과 선택 → 세션 열기 → 짧은 초안 입력 후 앱을 백그라운드/복귀한다.
3. 같은 계정의 `/api/ui-events` 조회에서 `view_open`, `search_*`, `compose_*`, `app_*`를 확인한다. compose attrs에는 초안 길이만 있고 원문은 없어야 한다.
4. 전송 결과까지 볼 때만 전용 테스트 세션에서 메시지를 보낸다. 정상 응답이 실제 `sessionEventId`를 포함한 경우에만 그 필드가 있어야 한다.

배포 전에는 endpoint 404를 반복 확인하거나 이를 근거로 앱 코드를 변경하지 않는다.

## iOS handoff

기존 배포 문서 atom `4f866005-9023-4162-9a98-1c15073887a6`은 EAS `--profile production` + 명시 실행을 iOS TestFlight 정본으로 규정하고, Codemagic은 App Store Connect 통합·실행 검증이 끝나지 않은 대체 경로라고 적고 있다. `eas.json`의 remote versioning/production autoIncrement/ASC ID는 그 경로와 정합한다. Codemagic 전환이나 신규 배포 체계 구성은 이 PR 범위가 아니다.

현재 노드에는 `eas` CLI가 없고 live EAS build 조회도 하지 못했으므로, 최신 성공 build ID·시각은 **미확인**이다. atom `0ce22086-0694-4f7e-bc27-8ebebbe031cf`의 TestFlight build 53은 과거 제출 및 스트리밍 회귀 사례일 뿐 현재 성공 근거로 쓰지 않는다. 실제 빌드·제출은 머지 뒤 위임자가 EAS 정본 절차로 실행하며, 이 작업에서는 실행하지 않았다.
