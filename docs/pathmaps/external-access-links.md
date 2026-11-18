# 외부 접속 링크(/x) 경로

> 범위: 기간제 외부 접속 링크의 공개 표면. `/x` 아래 다섯 라우트가 인증 없이 열리는 유일한 경로이며, 링크 키 하나로 안내 읽기·메시지 보내기·회신 기다리기·이력 읽기·실행 중 턴 중지를 한다. 키는 URL 경로 `/x/<key>`로만 받고 쿠키나 `Authorization` 헤더로 신원을 세우지 않는다.

## 라우트와 권한

| 메서드·경로 | 권한 | 버킷 | 하는 일 |
| --- | --- | --- | --- |
| `GET /x/:key` | 없음 | read | 안내문. 기본 `text/plain` 마크다운, `Accept: application/json`이면 JSON |
| `POST /x/:key/messages` | `send` | send | 메시지 접수. `202 {request_id, status:"accepted"}` |
| `GET /x/:key/messages/:requestId?wait=0..25` | `read_own` | read(HTTP 요청당 1회) | 내 요청 상태·회신 조회. `wait>0`이면 끝나지 않은 요청을 붙잡는다 |
| `GET /x/:key/history?before&limit=1..50` | `read_history` | read | 대상 세션 대화 이력의 `user`/`assistant` 발화만 |
| `POST /x/:key/stop` | `control` | send | 대상 세션의 실행 중 턴 중지. `200 {ok:true}`, 실행 중이 아니면 `409 {code:"not_running"}` |

권한은 `external_access_grants.permissions`의 부분집합이고, 링크 발급 API(`/api/access-links`)가 정한다. 안내문에는 그 링크가 실제로 가진 권한의 동작만 나온다.

## 입구 판정

모든 `/x` 요청은 매번 `ExternalAccessGrantRepository.resolveGrant(rawKey)`로 키를 다시 읽는다(`orch-server-ts/src/external_access/public_link_routes.ts`의 `resolveLinkGrant`).

1. `resolveGrant`가 실패하면 그 `status`(401/403)로 끝낸다.
2. 성공해도 `grant.kind !== "link"`이면 틀린 키와 **같은** 401 본문으로 끝낸다. 수신 웹훅의 `ssxw_` 키처럼 다른 kind의 키는 `/x` 입구에서 키 오류와 구별되지 않는다. 이 판정은 권한 검사보다 먼저다.
3. 그다음 필요한 권한이 없으면 403이다.

kind 확인은 `/x` 입구 공통 함수에만 있고 `resolveGrant` 자체는 바꾸지 않는다(그 리팩터는 #1458 소관). 롱폴링은 응답을 내보내기 직전에 같은 판정을 한 번 더 한다. 기다리는 사이 링크가 만료·폐기됐거나 kind가 달라졌으면 데이터 없이 401이다.

`resolveGrant`는 쿠키와 `Authorization`을 보지 않는다. `/x` 요청에 그런 헤더가 붙어도 신원에 영향이 없고, 접수되는 `caller_info`는 서버가 만든 `{source:"external", transport:"access_link", grant_id, display_name:링크 라벨, user_id:null, issued_by:발급자}`다.

## 응답 공통

- `/x`의 모든 응답(오류, 404, 가드 401 포함)에 `Cache-Control: no-store`와 `Referrer-Policy: no-referrer`가 붙고 CORS 헤더는 없다.
- 오류 본문은 `{error:{code, message}}` 하나의 모양이고 메시지는 고정 문구다. 내부 오류 문구·키·경로를 담지 않는다.
- 매칭되지 않은 `/x` 경로는 메서드와 무관하게 같은 404 본문(`{error:{code:"not_found", message:"Not found"}}`)이다. `DASHBOARD_DIR` 대시보드 404 처리 여부와 상관없다.
- 라우트가 매칭되기 전에 가드가 거절하는 메서드(예: `DELETE /x/:key/messages`)는 다른 보호 경로와 같은 401을 받되 위 두 헤더를 함께 받는다.
- 잘못된 URL(`%zz` 등)은 라우터 진입 전에 `frameworkErrors`가 받아 `/x`면 같은 400 본문으로 끝낸다.

## 메시지 접수

- 본문은 엄격한 JSON 객체 `{text, request_id?}`다. 모르는 키가 있으면 400, `text`가 공백뿐이면 400, 본문 상한 256KiB 초과는 413, `Content-Type`이 JSON이 아니면 415, JSON 파싱 실패는 400이다.
- `request_id`는 멱등 키다. 같은 링크가 같은 `request_id`와 같은 본문을 다시 보내면 같은 202를 돌려주고, 본문이 다르면 409 `request_conflict`다. 형식이 틀리면(빈 문자열·200자 초과) 400 `invalid_request_id`다.
- 접수는 한 트랜잭션에서 receipt와 전달 원장을 함께 만든다(`ExternalInputService.admit`). 링크가 만료·폐기된 뒤에도 이미 접수된 메시지는 처리된다.
- 하나의 링크는 하나의 발신자다. 같은 링크를 여러 사람이 나눠 쓸 수 없다.

## 상태 조회와 롱폴링

`GET /x/:key/messages/:requestId`의 응답은 세션 도구 `readExternalRequestStatus`와 같은 모양이다.

```blockquote
{request_id, status, outcome, replies, session:{state}}
```

- `status`는 원장 집계 상태(`pending`, `delivered`, `consumed`, `dead_letter` 등)이고 `completed`·`failed`가 종결이다. `outcome`과 `replies`로 회신을 읽는다.
- 같은 링크의 다른 `request_id`나 없는 `request_id`는 둘 다 404다.
- `wait`는 0~25 정수, 기본 0이다. 0이면 즉시 답한다.
- `wait>0`이고 종결이 아니면 응답을 붙잡는다. 깨우는 신호는 `RuntimeSessionEventHub.subscribe(target_session_id)`의 세션 이벤트와 회신 도구가 쓰는 `ExternalReplySignal`이다. DB 재조회 시작 사이는 신호와 상관없이 1초 이상이고, 재조회가 도는 동안 온 신호는 다음 간격 뒤 재조회에 쓰인다. `status`·`outcome`·`replies` 개수·`session.state` 중 하나가 바뀌면 답한다. 시간이 다하면 마지막 재조회에서 1초가 지난 경우에만 한 번 더 읽고, 아니면 마지막으로 읽은 값으로 답한다.
- 클라이언트가 끊으면 구독을 풀고 멈춘다.
- read 버킷은 HTTP 요청당 한 번만 소비한다. 기다린 시간과 재조회 횟수는 버킷을 더 쓰지 않는다.

## 이력

`GET /x/:key/history`는 `ConversationHistory` 투영에서 `user`·`assistant` 항목만 남긴다. 첨부·공지·오류·세션 이벤트·busy·도구 호출·`caller_info`·메타데이터는 나가지 않는다.

- `limit`은 1~50, 기본 50이다. `before`는 이전 응답의 `next_before`(항목 id)를 준다.
- 응답은 `{items:[{id, role, text, at, sender?}], next_before?}`다. `sender`는 외부 발신일 때만 `{kind:"external", label}`로 붙는다.
- 모르는 `before`는 400 `invalid_before`다.
- 세션의 최초 입력을 지시문으로 바꾸는 투영(`first_input_is_initial_instruction`)은 끈다.

## 버킷

`ExternalInputService`와 `/x` 라우트가 같은 `ExternalAccessTokenBucket` 인스턴스 하나를 공유한다. 키 규칙도 같다.

| 버킷 키 | 한도 | 소비 지점 |
| --- | --- | --- |
| `read:<grant id>` | 분당 120 | 안내, 이력, 상태 조회(HTTP 요청당 1회) |
| `send:<grant id>` | 분당 30 | 메시지 접수(`admit` 안), 중지 |

한도를 넘으면 429 `rate_limited`와 `Retry-After`(초)다. 메시지 접수가 한도를 넘으면 receipt 행을 만들지 않는다.

## last_used_at

안내 `GET /x/:key`는 `last_used_at`을 건드리지 않는다. 그 밖의 성공한 동작(접수, 상태 조회, 이력, 중지)은 `touchLastUsedAt`을 부른다.

## 로그 가림

키가 URL 경로에 있으므로 애플리케이션 로그 어디에도 키가 남지 않아야 한다(`tests/external-access-link-logging.test.ts`가 배포 조건이다). 정본 모듈은 `orch-server-ts/src/external_access/external_access_paths.ts`다.

- `requestLogPath`: 실제 경로가 `/x`이거나 `/x/`로 시작하면 매칭된 라우트가 다섯 템플릿 중 하나일 때만 그 템플릿(`/x/:key`, `/x/:key/messages`, …)을, 아니면 고정 `/x/:redacted`를 남긴다. 다른 경로는 지금처럼 라우트 템플릿이나 실제 경로다.
- 프로덕션 로거의 `req` 직렬화기: `req`를 통째로 로그에 남기는 모든 경로가 `/x` URL이면 같은 규칙으로 가린다. `/x`가 아닌 URL은 그대로 둔다.
- `onError`: `/x` 요청은 `{errorCode, method, path, statusCode, durationMs}`만 남기고 오류 객체를 남기지 않는다.
- 라우터 진입 전 오류(`frameworkErrors`): `/x`면 키가 섞인 원문 경로 대신 고정 400 본문을 쓴다. `/x`가 아닌 경로는 Fastify 기본 본문을 그대로 재현한다.
- 응답 본문에도 키를 담지 않는다. 안내문 본문은 예외다(그 링크의 키로 만든 URL과 curl 예시를 담는다).

nginx 쪽 로그 가림은 앱과 별도 조각이다. 아래 절과 `deploy/nginx/README.md`가 정본이다.

## nginx 조각 적용 순서

운영 443·80 server 블록은 server 수준 `access_log ... soulstream_diagnostic`을 두고, 그 로그는 `$uri`를, `error.log`는 요청 줄(`$request`)을 남긴다. 그래서 조각 없이 `/x/<key>`가 오면 키가 로그에 그대로 남는다.

- HTTPS server 블록에는 `location ^~ /x/`를 두는 `external-access-link.conf`를 기존 location들과 나란히 include한다. `access_log off`, `error_log /dev/null`, `client_max_body_size 320k`이고, `^~`라 `location /`의 `proxy_intercept_errors on`/`error_page 502 503 504`가 `/x/` 업스트림 오류를 대시보드 200으로 바꾸지 않는다.
- HTTP server 블록은 지금의 server 수준 `return 301`을 `location /` 안으로 옮긴 뒤 `external-access-link-http.conf`를 include한다. server 수준 `return`은 location 선택보다 먼저 실행되어 `location ^~ /x/`의 `access_log off`가 적용되지 않기 때문이다. 옮기지 않으면 80 요청의 키가 진단 로그에 남는다.
- **적용 순서: 앱의 `/x` 경로를 배포하기 전에 조각을 먼저 적용한다.** 반대 순서면 그 사이에 들어온 요청의 키가 로그에 남는다.
- 적용 뒤에는 `deploy/nginx/verify-external-access-link.sh`와 README의 합성 키 확인으로 세 로그(`soulstream-diagnostic.log`, `access.log`, `error.log`)에 키 전체와 두 조각(22자, 43자)이 없는지 본다.

location은 요청 헤더를 읽은 뒤 선택되므로, 그 전에 거절된 요청(헤더 줄 초과 400, 헤더 타임아웃 408)의 `$uri`는 server 수준 진단 로그에 남을 수 있다. 이 조각이 덮는 범위가 아니다.

## production 배선

`orch-server-ts/src/production.ts`는 `externalAccessGrants`와 `providers.runtime.sessionActionCommandRoutes`가 모두 있을 때만 `ExternalInputService`(`sql: productionSql`, grants, `createExternalInterventionDispatch(sessionActionCommandRoutes)`, 공용 `externalAccessTokenBucket`), `ExternalReplySignal`, `ConversationHistory(productionSql)`, 중지 함수(`executeInterruptCommand`), 공개 URL, `runtimeServices.sessionEventHub`로 `/x` 라우트를 등록한다. 하나라도 없거나 공개 URL이 비면 `/x` 라우트를 등록하지 않는다(fail closed). 같은 reply signal을 MCP 호스트의 외부 접속 옵션에도 넘겨 회신 도구가 롱폴링을 깨운다. 신호가 없어도 회신 도구는 그대로 동작한다.

## 이 장을 갱신해야 하는 변경 부류

`/x` 다섯 라우트의 경로·권한·응답 모양·버킷 한도, `/x` 입구의 kind·권한 판정, 로그 가림 규칙(`external_access_paths.ts`, `production_logging.ts`, `production_auth_guard.ts`의 `/x` 분기), 롱폴링 신호, `/x` production 배선 조건, nginx 조각의 위치·적용 순서 변경.
