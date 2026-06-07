# 소울스트림 인증·권한 방향성 (auth/authz)

작성일: 2026-06-07
작성자: 서소영 (세션 651f13ab)
상태: 방향성 초안 — 향후 work-plan 입력용

## 한 줄 요약

전역 단일 서비스 토큰(`AUTH_BEARER_TOKEN`) + body `caller_info.email` 곁들임 구조는 멀티유저 이전의 임시 형태다. 두 축으로 정식화해야 한다: (1) 사람 직접 호출용 **per-user API key**, (2) MCP/내부 중계용 **세션 owner 기반 위임 모델**.

## 배경 — 지금이 어색한 이유

- `AUTH_BEARER_TOKEN`은 전역 단일 토큰이라 **토큰 자체에 주인(신원)이 없다.**
- 그래서 신원을 body `caller_info.email`로 곁들이고, "이 email을 믿어도 되나"를 `auth_mode=="service_token"` 가드로 판정하는 로직이 생겼다.
- 이 복잡성 전체가 "토큰에 주인이 없다"는 한 가지 결함의 파생이다.
- 멀티유저(여러 사용자 + 폴더 권한 격리)가 실제로 생긴 시점에서, 이 임시 구조의 한계가 드러났다 (admin도 차단되던 P0 버그, JWT spoof 위험 등).

## 현재 상태 (2026-06-07 기준, 코드 머지 완료)

`access_for_request`의 신원 우선순위가 정본:

1. JWT(쿠키/Bearer) 있으면 → JWT email이 신원. body caller_info 무시 (spoof 차단)
2. JWT 없고 service-token이면 → body `caller_info.email`을 신원으로 신뢰
3. service-token인데 caller email도 없으면 → unrestricted (PR #176, 내부 자동화용)

경로별:

| 경로 | 인증 | 신원 출처 | 상태 |
|---|---|---|---|
| 대시보드(웹) | JWT 쿠키 (Google OAuth) | JWT email | 정상 (restricted 격리) |
| API 직접 — 사용자 (soul-app) | 사용자 Bearer JWT | JWT email | 정상 |
| API 직접 — 서비스 | 정적 service-token Bearer | body caller_info / 없으면 unrestricted | 임시 정식화 |
| MCP → orch | service-token Bearer + body caller_info | caller_info.email | 임시 정식화 (이번 작업) |

이번에 머지된 관련 PR: #172(TS email 보존), #173(service_token 마커 + access_email + spoof 차단), #174(sessions create·intervene), #175(execute_proxy 게이트), #177(나머지 session 라우트), #176(사용자 작성, service-token no-caller=unrestricted 정본).

→ 이 전부는 "전역 토큰 + caller_info 곁들임"이라는 **임시 구조를 메운 보강**이다. 근본 해결이 아니다.

## 축 1 — 사람 직접 호출: per-user API key

사용자가 스크립트·CLI·soul-app 등으로 **직접** orch API를 호출하는 경우.

- 정답: 각 사용자가 **자기 API key를 발급**하고, 그 **키가 신원·권한을 carry**한다 (키 = 주인).
- 인증 = JWT(브라우저) 또는 API key(프로그램) — 둘 다 토큰에 주인이 있음.
- 구성요소:
  - API key 테이블: `key_hash → user(email/id) + scope/role`
  - 발급 UI (대시보드 사용자 설정)
  - 저장은 해시 (평문 비보관)
  - 키 회전·폐기
- 효과: `access_for_request`의 신원 분기가 "토큰에서 주인을 읽는다" 하나로 단순화. body email 신뢰 로직 불필요.
- 현재: **없음** (전역 `AUTH_BEARER_TOKEN`만 존재).

## 축 2 — MCP/내부 중계: 세션 owner 기반 위임

MCP 서버가 **여러 사용자의 세션을 대신해** orch를 호출하는 중계 경우 (create_remote_agent_session, intervene, completion relay, cron 등).

### 왜 per-user key/토큰 passthrough가 안 맞나

- 에이전트 세션은 **장기·비동기**다. 사용자가 자리를 떠도 백그라운드 위임·relay·cron·며칠 뒤 resume이 orch를 호출한다.
- 그 시점엔 사용자 JWT(7일)나 인터랙션 토큰이 만료·부재.
- 따라서 "호출마다 그 사용자의 키를 실어 보낸다"는 모델은 MCP 중계에서 깨진다.

### 정답 구조 — "토큰에 주인"이 아니라 "세션에 주인, 서버가 진실 보유"

1. **인증 계층 (서비스 자격)**: MCP 서버는 전역 공유 토큰이 아니라 **named service principal**(MCP 서버 전용, 회전·폐기 가능)로 orch 인증. "세션을 대행할 자격"만 증명.
2. **신원 계층 (누구 권한으로)**:
   - 세션 생성 시점(사용자가 JWT로 인증해 만든 그 순간)에 orch가 `session.owner = 그 사용자`를 **서버 측에 기록**.
   - 이후 그 세션을 대신하는 모든 호출은 `caller_session_id`로 **owner를 서버 DB에서 역참조**해 권한을 정한다.
   - body의 caller_info.email은 표시·감사용일 뿐, 권한 판정에 쓰지 않는다.
   - → 신원의 출처가 "body가 주장하는 값"에서 "서버가 보관한 사실"로 바뀌어 **spoof가 원천 불가**. 토큰 만료와 무관(owner는 세션에 영속).
3. **시스템/자동화**: owner 없는 진짜 시스템 세션(cron·내부 relay)은 명시적 `system` actor 권한으로. → `#176`의 "no-caller=unrestricted"(암묵 통과)를 "system 권한"(명시)로 대체.

### 현재 vs 정답 (축 2)

| | 지금 (이번 작업) | 정답 |
|---|---|---|
| 서비스 인증 | 전역 `AUTH_BEARER_TOKEN` | named service principal |
| 권한 신원 | body `caller_info.email` 신뢰 | `caller_session_id → session.owner` 역참조 |
| spoof 방지 | "JWT 우선 + service_token 가드" 로직 | 구조적으로 불가 (서버가 owner 보유) |
| 장기/비동기 세션 | email만 실으면 됨 | owner 영속이라 그대로 동작 |
| 시스템 호출 | no-caller=unrestricted (암묵) | system actor 권한 (명시) |

## 점진 경로

1. ✅ (완료) caller_info.email delegation — 전역 토큰 시대 임시 보강 (PR #172~177)
2. **세션 owner 기록 + 권한 판정을 owner 역참조로 전환** (축 2 본체). caller_info.email은 fallback/감사로 강등. 이미 `caller_session_id` 체인이 있으니 거기에 owner를 얹는다.
3. **per-user API key 도입** (축 1) + service principal named화. 사람 직접 호출과 서비스 중계 인증을 분리.
4. 전역 `AUTH_BEARER_TOKEN` 점진 폐기.

## 착수 전 확인 필요 (open questions)

- **세션 테이블에 생성자(owner)가 이미 기록되는가?** 이미 있으면 축 2의 2단계는 "판정을 owner 역참조로 돌리기"만으로 가벼움. 없으면 owner 기록부터 추가.
- child 세션(위임 파생)의 owner 전파 규칙: caller의 owner를 상속하는가?
- per-user API key의 scope/role 모델 범위 (폴더 권한과 어떻게 맞물리나 — 기존 `dashboard_user_folder_access`와 통합).
- service principal과 system actor의 권한 경계 (impersonation 허용 범위).
- 하위호환: 전역 토큰을 쓰는 기존 통합(cron 스크립트 등)의 마이그레이션 순서.

## 관련 정본 위치 (코드)

- `orch-server/src/soulstream_server/dashboard_access.py` — `access_for_request`, `require_folder_allowed`, `require_session_allowed` (access_email 도입됨)
- `orch-server/src/soulstream_server/api/auth.py` — `verify_auth`, service_token/jwt 마커
- `orch-server/src/soulstream_server/users.py` — `DashboardUserCache` (사용자/폴더 권한 캐시)
- `orch-server/src/soulstream_server/api/sessions.py` — 세션 생성/intervene (owner 기록 후보 지점)
- `packages/soul-common/src/soul_common/auth/caller_info.py`, `jwt.py` — caller_info·JWT
- `soul-server-ts/src/mcp/orch_proxy.ts` — MCP→orch 인증 (현재 전역 Bearer)
- `soul-server-ts/src/caller_info.ts` — agent caller_info 생성 (email 보존됨)

## 관련 트렐로 카드

- pKb1R768 — orch 권한 P0 (caller_info.email 신원 승격, 슬라이스 1~3)
- hNEsIKjc — access_email 확대 (execute_proxy + 나머지 라우트, 슬라이스 A·B)
