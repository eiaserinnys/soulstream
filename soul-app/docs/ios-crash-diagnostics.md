# iOS 크래시 수집·조회 운영

EAS Observe는 기존 JavaScript 오류와 MetricKit native diagnostic을 전달한다. 앱 진단은 watchdog 전후의 제한된 실행 이력을 추가한다. 이것은 원인 수정이나 crash 완치를 뜻하지 않는다.

## 전달과 보존

설치된 `expo-observe@57.0.23`에서 `Observe.logEvent(name, options)`는 `void`를 반환한다. iOS 구현은 SDK 소유 DB에 기록을 요청하지만 enqueue 완료를 확인하는 API가 없다. `Observe.dispatchEvents()`의 `Promise<void>`도 원격 수신 ACK가 아니다. SDK 큐와 cursor는 SDK 소유이며 앱에서 ACK를 읽을 수 없다.

진단 청크는 `Observe.logEvent`의 body가 아니라 고정 attribute `soul_app_diagnostics_payload`에 넣는다. 고정된 EAS CLI `24.7.0 observe:events --json`은 event `properties`를 반환하지만 body는 응답에 포함하지 않기 때문이다. 설치 SDK는 log attribute를 지원하고 event당 attribute 수를 128개로 제한한다. 앱은 한 attribute에 3,000 UTF-8 byte 이하의 JSON 청크 하나만 넣는다. 앱 청크 상한은 SDK body 검증과 별개이며, 원격 수신은 실제 CLI 조회로 확인한다.

앱은 SDK와 별도로 bounded outbox를 유지한다. 각 이전 실행은 독립 진단 `report_id`와 청크별 `chunk_index`/`chunk_count`를 저장한다. 일부 청크 전송 후 실패하면 이미 전달 요청된 청크가 다음 시도에서 중복될 수 있다. 앱은 `pending`, `dispatch_requested`, `sdk_call_finished_unconfirmed` 상태를 구분하고 SDK 호출 반환만으로 report를 지우지 않는다. 실제 원격 수신은 EAS 이벤트에서 payload를 조회했을 때만 확인한다. 재전송은 같은 report/chunk ID로 최대 3회, 72시간까지 한다. 별도 ACK 서버는 없다.

| 저장소 | 한도 | 한도 초과·만료 |
|---|---|---|
| JS 최근 실행 기록 | 최근 60초, 최대 128건, 직렬화된 이벤트 32 KiB | 오래된 항목부터 제거하고 제거 건수를 보고 |
| 앱 report outbox | 최대 3개 보고, payload 합계 96 KiB, 보고당 최대 12 청크, 72시간, 보고당 전송 요청 최대 3회 | 오래된 보고를 버리고 `dropped_count`에 반영 |
| iOS native outbox | 최대 64건, 원자 교체 JSON 파일 16 KiB, 72시간 | 오래된 기록부터 버리고 native drop counter에 반영 |
| 앱 outbox JSON | 256 KiB | 저장 불가로 남기고 native 기록 ACK를 하지 않음 |

JS는 native record를 읽은 뒤 report outbox와 새 JS journal 저장을 모두 끝낸 다음 읽었던 native ID만 ACK한다. JS journal/outbox 중 하나라도 읽지 못하면 recovery를 보류하고 두 저장 키를 그대로 둔다. native 파일은 serial storage queue에서 읽고 쓰며 `.atomic` 교체를 사용한다. 읽은 뒤 추가된 native record는 ACK 대상 ID에 없으므로 보존된다. 일반 종료, 앱 업데이트, OS kill은 crash로 단정하지 않고 다음 실행에서 `prior_run_exit: "unknown"`으로 보고한다.

## 수집 범위와 실행 경계

JS는 화면 분류, 모달 호출 위치와 종류, AppState `active`/`inactive`/`background`, SSE 연결·해제·오류·background cleanup, auth/search SecureStore 및 settings/ui AsyncStorage 작업, UI 사용기록 저장, widget credential 동기화, Observe 이벤트 enqueue/dispatch 요청을 고정 source와 numeric operation code로 기록한다. 저장 이벤트에는 key/value가 없다. elapsed time은 monotonic clock, 상관 시각은 UTC wall clock이다. SSE는 메시지 원문 대신 건수와 UTF-8 byte 합계만, 연결은 source별 열기·닫기·오류 건수만, store는 변경 건수만, feed는 commit 건수와 render-to-effect 최대 시간만 남긴다. 실행 세션 수도 건수로만 기록한다.

| operation code | source | 경계 |
|---:|---|---|
| 1, 2 | `async_storage` | JS journal checkpoint, 앱 outbox 저장 |
| 3, 4 | `native_lifecycle` | native 기록 읽기, JS 저장 뒤 native 기록 ACK |
| 10, 11, 12 | SSE stream | 연결 구성, 연결/리스너 정리, background cleanup |
| 20–23 | `usage_storage` | 수집 시작, inactive 저장, 복귀 저장, flush |
| 30 | `usage_widget` | widget credential bridge 동기화 |
| 40 | `native_storage` | iOS native outbox 파일 저장 |
| 1, 2 | `observe` | SDK logEvent 호출, SDK dispatchEvents Promise 경계 |
| 20–22 | auth/search/settings/ui | 영속 상태 읽기, 저장, 제거; key/value 미기록 |

UIKit observer는 main queue에서 `willResignActive`, `didEnterBackground`, `willEnterForeground`, `didBecomeActive`, `willTerminate`를 기록한다. recorder는 프로세스 singleton이므로 observer도 프로세스 수명 동안 하나씩만 등록된다. native main queue probe는 active 동안만 동작하고 `willResignActive`에서 멈춘다. JS AppState는 `inactive`에서 timer를 멈추고 비동기 checkpoint를 요청하며 `background`에서도 한 번 더 요청한다. 종료 순간 동기 flush나 background를 깨우는 timer는 없다. OS가 JS를 멈추면 JS cleanup/checkpoint는 끝나지 않을 수 있다. native callback과 파일 저장도 비동기이므로 마지막 미완료 write의 생존을 보장하지 않는다.

JS journal은 active 상태에서 5초마다 저장을 시도한다. inactive/background checkpoint는 best effort다. 다음 실행에서 복구되는 것은 저장 완료가 반환된 마지막 snapshot이다. write 진행 중 종료되면 그 전 snapshot이 남는다. 미완료 operation은 시작 기록과 끝 기록 사이에 저장 경계가 끊겼다는 뜻이며 crash 확정이 아니다. 정상 종료, 앱 업데이트, OS kill 모두 같은 상태로 표시한다.

## JS와 native UI 지연

JS event-loop timer는 active에서 1초 간격으로 실행하고 5초 bucket의 최대 지연을 저장한다. 50 ms 미만 지연은 개별 기록하지 않는다. 복귀 뒤 10초 이상 timer gap은 background suspension과 JS stall을 구분할 수 없어 JS hang으로 기록하지 않고 frame baseline을 다시 잡는다. 더 짧은 gap도 JS hang 확정 증거는 아니다.

설치된 `expo-app-metrics@57.0.20`의 `getFrameRateMetricsAsync()`는 process 누적 rendered/expected/dropped/slow/frozen frame 및 freeze-time counter를 준다. 5초 active sample 간 차이를 저장하지만 frame별 presentation 시각은 제공하지 않는다. 누적 FPS/drop만으로 native UI 응답 지연을 판단하지 않는다.

별도 native main queue probe는 active 중 utility serial queue에서 초당 한 번 main queue block을 예약한다. 1.5초 안에 응답하지 않으면 native outbox에 timeout 한 건을 기록하고, 응답한 block은 시간 구간별 응답 수와 최대 scheduling delay에 포함한다. 미처 실행되지 않은 main queue block의 ID는 `inactive`/`active` 전환을 넘어 callback이 실행될 때까지 유지한다. 따라서 프로세스 전체에서 대기 중 block은 최대 하나이며, 영구 정지하면 이후 probe도 중단된다. 이 값은 main queue scheduling delay이며 frame presentation 시각이나 원인 stack은 아니다. main thread가 멈춘 동안 utility queue가 timeout을 파일에 남길 수 있지만 프로세스가 먼저 종료되거나 파일 write가 끝나지 않으면 사라질 수 있다. background suspension은 probe가 `willResignActive`에서 멈추므로 hang으로 세지 않는다.

MetricKit callback에서 받은 hang은 payload의 원래 app version/build, 길이를 제한해 추출한 숫자 OS version/build, `timeStampBegin`/`timeStampEnd` 창을 보존한다. 개별 hang의 정확한 발생 순간은 MetricKit payload가 제공하지 않으므로 `timestamp_ms`는 payload window 끝이며 별도 `window_start_ms`/`window_end_ms`와 `duration_ms`를 함께 봐야 한다. 지연 callback을 현재 설치 build나 upload 기기 OS version으로 덮지 않는다. main queue가 멈춘 바로 그 순간 자체 측정 결과를 즉시 기록할 수 없고 MetricKit은 나중에 오거나 누락될 수 있다.

### MetricKit stack과 dSYM

raw `MXDiagnosticPayload`/callStack JSON, 원본 binary path, symbol name, 메모리 주소는 보내지 않는다. 최대 16 frame에 대해 고정 binary class, 유효한 binary UUID, text-segment offset, sample count만 남기고 절단 여부를 `stack_truncated`에 담는다. UUID는 앱 사용자·세션 식별자가 아니라 해당 빌드의 Mach-O binary image 식별자다. UUID는 `soul_app`과 allowlist에 든 공개 Apple/RN/Hermes/Swift/Objective-C/C++ runtime binary class에만 남기며, 미분류 binary는 `other`와 허용 숫자 정보만 남긴다.

프레임을 함수명으로 복원할 때는 해당 MetricKit event의 원래 `build_number`로 앱 및 bundled RN/Hermes binary와 dSYM을 찾는다. `dwarfdump --uuid <binary-or-dSYM>` 결과의 UUID가 payload `binaryUuid`와 일치해야 한다. UUID로 image를 고른 뒤 그 image의 `__TEXT` segment와 `offset`을 이용해 해당 archive의 dSYM으로 symbolicate한다. Apple 공개 framework frame은 원래 `osVersion`과 UUID가 맞는 OS symbols가 있을 때 해석한다. EAS event의 `deviceOsVersion`은 회수 실행 기기 정보이므로 이 목적으로 쓰지 않는다. class+offset만으로는 다른 빌드/OS의 image에서 함수명을 유추할 수 없다. 앱 executable 이름과 UUID가 보존되어 있으므로 app binary도 같은 방식으로 대응한다. 이번 PR에서는 build 120/121의 실제 dSYM을 내려받아 함수명 복원을 실행하지 않았다. archive/dSYM 확보 및 UUID 매칭은 EAS build 후 확인 gate다. Apple의 [MetricKit call stack](https://developer.apple.com/documentation/metrickit/callstacktree), [binary UUID와 offset JSON](https://developer.apple.com/documentation/metrickit/mxcallstacktree/jsonrepresentation%28%29/), [Xcode crash symbolication](https://developer.apple.com/documentation/xcode/adding-identifiable-symbol-names-to-a-crash-report?changes=_9%2C_9) 문서를 따른다.

MetricKit SDK는 현 설치 버전에서 `MXMetricManagerSubscriber`를 사용한다. Apple이 대체 `DiagnosticReport` API를 안내하지만 이번 변경에서 전환하지 않았다. 지원 OS별 native compile/runtime과 실제 MetricKit 전달 여부는 TestFlight/device gate다. 별도 stack sampler는 추가하지 않았다.

### 합성 흐름 overhead

`node scripts/benchmark-session-diagnostics.cjs`는 1/5/10개의 합성 세션마다 SSE 연결 open/error/close 각 1회, 메시지 200건, store update 250건, feed commit 20건을 비교한다. 세션당 473개 operation이며 각 시나리오에서 5회 warmup 뒤 30회 중앙값이다. checkpoint는 in-memory AsyncStorage stub이므로 파일 I/O와 실기기 성능을 측정하지 않는다.

| 합성 세션 수 | 기준 workload | 진단 기록 구간 | 진단 증가분 | checkpoint | 기록+checkpoint |
|---:|---:|---:|---:|---:|---:|
| 1 | 0.004 ms | 0.021 ms | 0.018 ms | 0.303 ms | 0.325 ms |
| 5 | 0.002 ms | 0.014 ms | 0.012 ms | 0.206 ms | 0.221 ms |
| 10 | 0.003 ms | 0.028 ms | 0.025 ms | 0.188 ms | 0.216 ms |

이 수치는 작은 Node 합성 workload의 JS 비용이다. 실제 AsyncStorage/native 저장과 기기 frame 영향은 실기기 검증 전에는 알 수 없다.

## 개인정보 경계

payload에는 fixed enum, numeric/boolean allowlist, 검증된 app version/build, 독립 UUID `report_id`와 `diagnostic_id`, allowlist native stack metadata만 들어간다. route 이름은 정적 화면 분류로 바꾸고 params는 읽지 않는다. API 응답, SSE 원문, 대화/제목, Soulstream task/session UUID, URL/query/fragment, 인증 토큰은 기록하지 않는다. 기존 error sanitizer와 local recovery UX를 보존한다. EAS SDK가 자체 session metadata를 붙일 수 있지만 앱 payload에는 이를 상관 ID로 쓰지 않는다. 재시도 중복 판정은 `(report_id, chunk_index)`로 한다.

기존 `expo-router`/`react-navigation` 자동 integration은 비활성화 상태로 유지한다. production profile에는 synthetic marker, crash 버튼, 상시 synthetic event 발송이 없다.

## EAS 조회와 청크 재조합

인증된 Expo 계정으로 확인한다. 인증 조회 결과에는 계정 scalar만 사용하고 credential/environment 전체를 출력하지 않는다.

```bash
npm exec --yes --package eas-cli@24.7.0 eas -- whoami
npm run diagnostics:ios-errors
npm run diagnostics:ios-error-fingerprint -- --fingerprint <fingerprint>
npm run diagnostics:ios-session-reports
```

`--platform ios`는 iOS만 선택하고 iPadOS는 별도 platform이다. `--platform apple`은 iOS+iPadOS와 tvOS/macOS를 포함한다. iPadOS 오류 그룹, version, session report도 조회하기 위해 Observe 운영 script 네 개가 모두 `apple`을 사용한다. 빌드 필터를 생략해야 앱 payload의 원래 `build_number`와 EAS 이벤트를 업로드한 실행 build를 혼동하지 않는다. `--build-number`는 업로드 실행의 build를 거르므로 앱 업데이트 뒤 회수한 이전 실행 기록에는 붙이지 않는다.

```bash
npm exec --yes --package eas-cli@24.7.0 eas -- observe:events soul-app.diagnostics.chunk \
  --platform apple --days 14 --environment production --limit 100 --json
```

응답의 `events[]`에서 event `id`, `timestamp`, `deviceOs`, `deviceOsVersion`, `appVersion`, `appBuildNumber` 및 `properties`를 보관한다. EAS SDK가 함께 반환하는 session/client metadata는 상관관계 키로 쓰지 않는다. 한 페이지에 `pageInfo.hasNextPage`가 true이면 `pageInfo.endCursor`를 다음 요청의 `--after <cursor>`에 넘기고 false가 될 때까지 모든 페이지를 읽는다. 각 event의 `properties`에서 key `soul_app_diagnostics_payload` 값을 가져와 JSON으로 parse한다. `report_id`로 묶은 뒤 `chunk_index`와 `chunk_count`를 확인한다.

다음 페이지는 직전 JSON의 cursor 값으로 요청한다. 모든 페이지 결과를 보관한 뒤 합친다.

```bash
npm exec --yes --package eas-cli@24.7.0 eas -- observe:events soul-app.diagnostics.chunk \
  --platform apple --days 14 --environment production --limit 100 \
  --after "CURSOR_FROM_PAGE_INFO" --json
```

각 페이지 JSON의 CLI event ID/발생 시각/device OS와 payload를 추출하는 예:

```bash
jq -c '.events[] as $event | $event.properties[] | select(.key == "soul_app_diagnostics_payload") | {eas_event_id: $event.id, uploaded_at: $event.timestamp, device_os: $event.deviceOs, payload: (.value | fromjson)}' page.json
```

재시도는 EAS event `id`가 달라도 같은 `(report_id, chunk_index)`를 갖는다. payload bytes가 같은 중복은 하나로 합치고, 값이 다르면 덮어쓰지 말고 충돌로 기록한다. `chunk_count`가 가리키는 1부터 N까지 index가 모두 있는지 확인한다. gap이 있으면 해당 report는 불완전하다. `dropped_count`는 앱/native bounded retention으로 버린 진단 기록을 나타내며, 이미 전송 요청한 청크의 원격 누락은 chunk gap으로 드러난다. 아직 모든 cursor page를 조회하지 않았거나 결과가 비었다면 전달 완료나 무발생을 뜻하지 않는다.

## TestFlight E2E와 배포 준비

검증은 일반 production/TestFlight 앱에서 실제 진단 흐름으로 한다. crash를 유도하거나 production synthetic event를 계속 보내지 않는다. 내부 `observe-verification` Ad Hoc profile, UDID 등록, 사용자 파일 복사는 이 E2E의 전제 조건이 아니다.

1. 위임자가 PR을 머지한 뒤 EAS remote iOS version과 최신 완료 build를 확인한다. 프로젝트는 `appVersionSource: remote`, production `autoIncrement: true`를 사용한다. `app.json`의 `buildNumber`는 seed이므로 최신 production build 121 이후 번호를 직접 하드코딩하지 않고 remote 값으로 증가시킨다.

   ```bash
   npm exec --yes --package eas-cli@24.7.0 eas -- build:version:get --platform ios --profile production --json
   npm exec --yes --package eas-cli@24.7.0 eas -- build:list --platform ios --status finished --limit 1 --json
   ```

2. EAS `production` profile로 archive를 만들고 App Store Connect/TestFlight에 제출한다. 기존 EAS managed iOS credential 경로를 사용한다. credential/private key 원문은 조회·출력하지 않는다. 이 PR 검수에서는 build와 submit을 시작하지 않았다.

   ```bash
   npm exec --yes --package eas-cli@24.7.0 eas -- build --platform ios --profile production
   npm exec --yes --package eas-cli@24.7.0 eas -- submit --platform ios --profile production --latest
   ```
3. TestFlight에서 설치한 뒤 특히 과거 재발 기기인 iPad에서 앱을 평소처럼 사용한다. active 상태에서 최소 5초 checkpoint를 남기고 background 전환 및 cleanup을 거친 뒤 앱을 정상 종료하거나 OS 종료를 기다리고 다시 연다. crash를 만들 필요는 없다.
4. 앱 재실행 후 인증된 Observe CLI에서 모든 페이지를 조회한다. 실제 `soul_app_diagnostics_payload` property가 있는 event를 찾고 이전 실행의 report ID/build/time, chunk count/index를 맞춘다. `deviceOs`가 iPadOS인 record도 결과에 포함되는지 확인한다. event가 0건이면 E2E 성공으로 보지 않는다.
5. 해당 build의 EAS archive dSYM과 payload frame UUID를 비교하고 최소 한 허용 frame이 실제 함수명으로 복원되는지 기록한다. dSYM 또는 MetricKit sample이 없으면 이 gate는 미확인으로 남긴다.

자동화 검증은 sanitizer, allowlist, 크기 제한, 저장 read/write 실패, background suspension 비오탐, checkpoint 중 종료 시 마지막 완료 snapshot, 전송 실패 뒤 재실행 재시도, native SDK enqueue 뒤 재시작, native ID snapshot ACK, partial chunk 관찰, 큰 stack 절단과 단일 청크 상한을 확인한다. 합성 1/5/10 세션 overhead는 JS in-memory 비교값으로만 보고한다. local Swift compiler/Xcode가 없는 환경에서 EAS iOS archive/autolinking/Swift API compile은 독립 build gate이며 코드 리뷰 통과를 대신하지 않는다. 실제 UIKit lifecycle, MetricKit 수신, dSYM symbolication, production TestFlight 원격 회수는 실기기/EAS gate로 남긴다.

## SDK 57·WebRTC build gate

`expo-doctor`의 `react-native-webrtc` 경고는 React Native Directory의 New Architecture metadata 경고다. 설치된 `react-native-webrtc@124.0.7`의 peer range와 legacy React-Core podspec만으로 RN 0.86 ABI 결함이라고 판정할 수 없다. 기존 production build 115 archive는 CocoaPods/Xcode 단계까지 성공했지만 이번 native module 변경의 compile/runtime 검증을 대신하지 않는다.
