"""대시보드 cookie/Bearer JWT에서 user payload 추출 및 caller_info 자동 조립.

방안 B (2026-05-07 결정): 웹 대시보드 세션 생성 시 클라이언트 변경 없이
서버가 cookie JWT를 디코드하여 caller_info에 발신자 신원을 자동 첨부한다.

패턴: "발신자 정보를 *그 정보를 자연스럽게 알고 있는 곳*이 채운다"
- 슬랙봇은 봇이 채움 (Slack API 보유)
- 웹 대시보드는 서버가 cookie JWT 디코드 (본 모듈)
- RN(soul-app)은 클라이언트가 채움 (자기 JWT 직접 보관)
- 위임은 서버 cogito MCP가 채움 (caller agent 정보 보유)
"""

from typing import Any, Optional

from fastapi import Request

from soul_common.auth.jwt import COOKIE_NAME, verify_token


def decode_dashboard_jwt_user(
    request: Request,
    jwt_secret: str,
    cookie_name: str = COOKIE_NAME,
) -> Optional[dict]:
    """대시보드 JWT 쿠키 또는 Bearer 헤더에서 user payload를 디코드한다.

    실패(jwt_secret 빈 값 / 토큰 없음 / 만료 / 위조) 시 None을 반환하여
    호출자가 base caller_info(IP/UA fallback)를 그대로 사용하게 한다.

    Args:
        request: FastAPI Request 객체
        jwt_secret: JWT 서명 키 (빈 문자열이면 즉시 None — auth 비활성)
        cookie_name: JWT 쿠키 이름 (기본 COOKIE_NAME)

    Returns:
        verify_token의 payload dict (예: {sub, email, name, picture, exp})
        또는 None.

    동일 패턴 참조:
    - oauth_routes.py:166-186 (auth_status)
    - oauth_routes.py:237-257 (create_auth_dependency)
    - soul-server dashboard/auth.py:require_dashboard_auth
    """
    if not jwt_secret:
        return None
    token = request.cookies.get(cookie_name)
    if not token:
        auth_header = request.headers.get("authorization", "")
        if auth_header.startswith("Bearer "):
            token = auth_header[7:]
    if not token:
        return None
    return verify_token(token, jwt_secret)  # 실패 시 내부에서 None 반환


def build_browser_caller_info(
    request: Request,
    jwt_secret: str,
    cookie_name: str = COOKIE_NAME,
) -> dict[str, Any]:
    """source='browser' caller_info를 조립한다.

    조립 규칙:
    1. 항상: source, ip, user_agent, referer, forwarded_for (HTTP 메타)
    2. cookie/header JWT 있으면: display_name(=name), user_id(=email or sub),
       avatar_url(=picture), email — 통합 스키마 v1 top-level promote.
       JWT payload의 빈/누락 필드는 caller_info dict에서 제외 (graceful).

    JWT payload 구조 (jwt.py:31-38):
        {sub=email, email, name, picture, exp}
    user_id=email인 이유: Google OAuth는 진짜 sub를 백엔드에 전달하지 않으므로
    email을 안정 식별자로 사용 (Plan C 보고 반영, 분석 캐시 §2 정정).

    호출자: orch-server api/sessions.py, soul-server dashboard/routes/sessions.py.
    """
    info: dict[str, Any] = {
        "source": "browser",
        "ip": request.client.host if request.client else None,
        "user_agent": request.headers.get("user-agent"),
        "referer": request.headers.get("referer"),
        "forwarded_for": request.headers.get("x-forwarded-for"),
    }
    user = decode_dashboard_jwt_user(request, jwt_secret, cookie_name)
    if user:
        # 통합 스키마 v1 top-level promote — 빈/None 필드는 누락 (graceful)
        promoted = {
            "display_name": user.get("name"),
            "user_id": user.get("email") or user.get("sub"),
            "avatar_url": user.get("picture"),
            "email": user.get("email"),
        }
        info.update({k: v for k, v in promoted.items() if v})
    return info


def has_caller_identity(caller_info: dict) -> bool:
    """caller_info가 *덮어쓸 가치 있는 정체성*을 가졌는지.

    R-6 fix(2026-05-11, atom G-20): `task_factory._has_identity`를 본 모듈로 추출 + 정본화.
    `extract_caller_info_from_metadata`가 *마지막 신원 박힌 entry* 추출에 동일 로직을 사용하므로
    §3 정본 하나로 합쳤다. `task_factory._has_identity`는 본 함수의 backward-compat alias.

    정체성 명시 source(IDENTITY_BEARING_SOURCES 7 원소)는 신원 필드가 비어도 True —
    orch/soul-server enrichment 헬퍼의 NOOP 정책과 §9 대칭. 그 외 source는 신원 필드
    (display_name 또는 avatar_url) truthy일 때만 True.

    Args:
        caller_info: caller_info 통합 v1 dict (atom ed3a216d).

    Returns:
        정체성 명시 source 또는 신원 필드 truthy면 True.
    """
    source = caller_info.get("source")
    if source in IDENTITY_BEARING_SOURCES:
        return True
    return bool(caller_info.get("display_name") or caller_info.get("avatar_url"))


def extract_caller_info_from_metadata(metadata) -> Optional[dict]:
    """세션 metadata JSONB array에서 *현재 caller*의 caller_info를 반환.

    metadata는 PostgresSessionDB가 반환하는 list[{"type": str, "value": ...}] 형식 —
    append-only history ledger.
    caller_info 통합 v1(atom ed3a216d) 정본 진입점.

    R-6 fix(2026-05-11, atom G-20): *마지막 신원 박힌* caller_info entry 우선 반환.
    이전(F-9~R-5): 첫 caller_info entry 반환 — `task_factory._resume_existing_task_locked`가
    intervene 시 `task.caller_info`만 인메모리 갱신, `append_metadata` 미호출이라 *옛 entry가
    정본으로 남는* 회로(sess-20260419114049-8cf09982 라이브 재현: D1 카드 첫 동기화에
    dashboard owner Jubok Kim 표시, 후속 SSE wire로 スバル 대체).

    정책:
    1. 마지막 *신원 박힌* caller_info entry 우선 (`has_caller_identity` True)
    2. 부재 시 마지막 *어떤* caller_info entry라도 (graceful — 옛 데이터 보존)
    3. metadata 전체에 caller_info entry 0건 → None

    호출 위치 (4 곳, §9 대칭):
    - orch-server/api/session_serializer.py: REST /api/sessions 응답 직렬화
    - orch-server/api/sessions.py: REST /api/sessions sessionList
    - soul-server/service/session_query_service.py: soul-server 자체 대시보드 REST
    - soul-server/service/session_eviction_manager.py: evicted task on-demand 복원

    Args:
        metadata: 세션 DB row의 metadata 컬럼(list[dict] 또는 None).

    Returns:
        마지막 신원 박힌 caller_info entry value > 마지막 caller_info entry value > None.
    """
    if not metadata:
        return None

    last_any: Optional[dict] = None
    last_with_identity: Optional[dict] = None
    for m in metadata:
        if not isinstance(m, dict) or m.get("type") != "caller_info":
            continue
        v = m.get("value")
        if not isinstance(v, dict):
            continue
        last_any = v
        if has_caller_identity(v):
            last_with_identity = v
    return last_with_identity if last_with_identity is not None else last_any


def build_agent_caller_info(
    *,
    agent_node: str,
    agent_id: Optional[str],
    agent_name: Optional[str],
    portrait_path: Optional[str] = None,
) -> dict[str, Any]:
    """위임 진입점에서 source='agent' caller_info 조립 (통합 v1 스키마).

    cogito MCP 위임 진입점(create_agent_session·create_remote_agent_session)이
    공유하는 정본 helper. 1-A·1-B 비대칭(원격 위임의 v1 promote 키 누락)을 차단한다.

    NOTE: build_browser_caller_info는 Request 객체를 직접 받아 source 결정까지 하지만,
    build_agent_caller_info는 이미 추출된 필드값을 받는다. 이는 각 진입점에서 발신자
    정보를 추출하는 *방식의 차이*에서 비롯된 의도적 비대칭이다 — browser는 HTTP Request에서
    JWT 디코드로 추출, agent는 cogito MCP 호출자가 TaskManager·AgentRegistry에서 사전 조회.
    helper는 추출된 값을 v1 dict로 *조립*하는 단일 책임만 진다 (design-principles §1 깊이).

    avatar_url은 orch-server의 노드 프록시 경로(/api/nodes/{node}/agents/{id}/portrait)를
    사용한다. 정본: orch-server/api/session_serializer.py:13-15 _build_portrait_proxy_url.
    soul-server 로컬 라우트(/api/agents/{id}/portrait)는 unified-dashboard에서 404.

    Args:
        agent_node: 발신 agent의 노드 ID (영속화 정본, avatar_url 경로에도 사용).
        agent_id: 발신 agent의 profile id. None 가능 (caller_task가 DB에 없는 경우).
        agent_name: 발신 agent의 표시명. None 가능 (caller_profile이 registry에 없는 경우).
        portrait_path: AgentProfile.portrait_path. truthy + agent_id truthy일 때만 avatar_url 부여.

    Returns:
        v1 caller_info dict. source/agent_node는 항상 채움, 신원 필드는 None 허용 (graceful).
    """
    avatar_url: Optional[str] = None
    if portrait_path and agent_id:
        avatar_url = f"/api/nodes/{agent_node}/agents/{agent_id}/portrait"
    return {
        "source": "agent",
        "agent_node": agent_node,
        "agent_id": agent_id,
        "agent_name": agent_name,
        # v1 promote (top-level 신원 필드)
        "display_name": agent_name,
        "user_id": agent_id,
        "avatar_url": avatar_url,
    }


SYSTEM_PORTRAIT_BASE = "/api/system/portraits"
"""orch-server 시스템 portrait 라우트 base path. agent portrait `/api/nodes/.../portrait`와
§9 대칭. 클라이언트(unified-dashboard / soul-app)는 server-relative URL을 그대로 사용 —
source별 자산 매핑 책임을 클라이언트에서 빌더로 끌어올린다 (R-3 fix, 2026-05-11)."""


def build_system_caller_info(*, node_id: str) -> dict[str, Any]:
    """소울스트림 서버 자신이 발신자인 시스템 메시지의 caller_info 조립 (통합 v1).

    graceful_shutdown 종료 예고, resume_shutdown_sessions 재개 안내 등 서버 lifecycle
    이벤트가 세션에 자동으로 인터벤션을 발송할 때 사용한다 (atom F-11D 정본).

    R-3 fix(2026-05-11): avatar_url을 server-relative URL `/api/system/portraits/system`으로
    박는다 (B-1 + system 통합, 위임자 게이트 결정). 이전 docstring "시각 자산 결정 책임은
    클라이언트가 진다 — soul-app: assets/icon-symbol.png, unified-dashboard:
    public/system-portrait.png"은 superseded — wire avatar_url 단일 정본.

    정본 자산: `packages/soul-common/src/soul_common/portraits/system.png`
    호스팅: `orch-server` `GET /api/system/portraits/{source}` (verify_auth 포함, agent
    portrait §9 대칭). 클라이언트는 caller_info.avatar_url을 그대로 사용 — source별 분기 없음.

    user_id도 None — 시스템은 사용자/에이전트와 달리 식별자가 무의미.

    Args:
        node_id: 발신 서버의 노드 ID (settings.soulstream_node_id).

    Returns:
        v1 caller_info dict — source/agent_node/display_name/avatar_url 채움, user_id None.
    """
    return {
        "source": "system",
        "agent_node": node_id,
        "display_name": "Soulstream",
        "user_id": None,
        "avatar_url": f"{SYSTEM_PORTRAIT_BASE}/system",
    }


def build_bot_caller_info(
    *,
    source: str,
    display_name: str,
    agent_node: Optional[str] = None,
) -> dict[str, Any]:
    """자동 봇(channel_observer / trello_watcher) source의 caller_info 조립 (통합 v1).

    R-3 fix(2026-05-11, G-5): build_system_caller_info의 봇 변형 — 사용자 식별 정보 없이
    plugin이 자동 실행하는 세션의 정체성을 박는다. system 패턴과 §9 대칭으로 server-relative
    avatar_url을 wire에 직접 박는다.

    R-4 fix(2026-05-11, G-11): 봇별 사본 패턴 → 단일 정본 파일. 라우트가 source → 파일 매핑.
    R-4 fix(2026-05-11, G-14): agent_node 인자가 host config 정합 사용 — plugin __init__에
    `Config.orchestrator.preferred_node or None` 전달 (다중 노드 환경 audit 가시성).

    정본 자산: `packages/soul-common/src/soul_common/portraits/system.png` (R-4 단일 파일)
    호스팅: orch-server `GET /api/system/portraits/{source}` (verify_auth 포함). `_PORTRAIT_FILE_MAP`
    이 source → `system.png` 매핑 (현재 3 source 모두 동일 자산, 디자이너 봇별 자산 결정 시
    매핑만 갱신). 클라이언트는 caller_info.avatar_url 그대로 사용 — 매핑 분기 없음
    (design-principles §3 정본 하나, §9 일관성).

    호출 정본:
    - seosoyoung-plugins/.../channel_observer/pipeline.py — source='channel_observer', display_name='채널 관찰자'
    - seosoyoung-plugins/.../trello/watcher.py — source='trello_watcher', display_name='트렐로 워처'

    Args:
        source: 봇 source 토큰. ALLOWED_SOURCES + _PORTRAIT_FILE_MAP에 등록되어야 함.
        display_name: 사용자 표시명 (예: '채널 관찰자', '트렐로 워처').
        agent_node: (옵션, R-4) 봇이 실행되는 노드 ID. plugin host config의 preferred_node
            (truthy) 또는 None (자동 라우팅). truthy일 때만 caller_info에 키 포함 — graceful.

    Returns:
        v1 caller_info dict — source/display_name/avatar_url 채움, user_id None.
        agent_node는 옵션 인자 truthy일 때만 포함.
    """
    info: dict[str, Any] = {
        "source": source,
        "display_name": display_name,
        "user_id": None,
        "avatar_url": f"{SYSTEM_PORTRAIT_BASE}/{source}",
    }
    if agent_node:
        info["agent_node"] = agent_node
    return info


def resolve_caller_info_or_system(
    *,
    body_caller_info: Optional[dict],
    request: Request,
    jwt_secret: str,
    system_node_id: str,
    cookie_name: str = COOKIE_NAME,
) -> dict[str, Any]:
    """진입 분류 dispatcher (R-6, B-7+B-4 결합).

    body.caller_info를 명시 박지 않은 외부 자동 호출자(예: `/home/eias/cron-jobs/run_session.sh`
    같은 cron 셸 스크립트, curl/스크립트류 자동 발사자)를 서버가 진입 시점에 system caller_info로
    분류한다. 호출자가 자기 정체성을 표현할 능력이 없을 때(셸/스크립트 환경) 검증자(서버)가
    JWT 내용으로 발급자 의도를 추론한다 — design-principles §1 (지식 경계, 정보를 자연스럽게
    가진 쪽이 채운다).

    분류 규칙:
        1. body_caller_info truthy → 그대로 반환. 슬랙·RN·위임 등 명시 caller_info 우선
           (기존 N.1 패턴 보존).
        2. decode_dashboard_jwt_user 성공 + payload['name'] falsy → build_system_caller_info.
           cron-jobs/run_session.sh 같은 minimal payload(email-only JWT) 발급자를 자동 인식.
           dev-login은 `name='Developer'` default(oauth_routes.py L223), OAuth는 Google
           userinfo.name 박음 → false-positive 자연 회피.
        3. 그 외 → build_browser_caller_info (기존 browser 흐름 — JWT 충실/decode 실패 모두).

    호출자 (4 진입점 §9 대칭):
        - orch-server/api/sessions.py:create_session, intervene
        - soul-server/dashboard/routes/sessions/_lifecycle.py:api_create_session, api_intervene

    Args:
        body_caller_info: request body의 caller_info 필드 (Optional). truthy면 그대로 forward.
        request: FastAPI Request 객체. HTTP 메타·cookie·Bearer 헤더 모두 본 객체에서.
        jwt_secret: JWT 서명 키. 빈 문자열이면 decode_dashboard_jwt_user가 즉시 None 반환.
        system_node_id: system 분류 시 build_system_caller_info에 전달할 노드 ID.
            orch: body.nodeId(create) or node.node_id(intervene). soul-server:
            settings.soulstream_node_id. 빈 문자열도 graceful (system source는
            user_id/node_id 식별과 무관 — build_system_caller_info docstring 정합).
        cookie_name: JWT 쿠키 이름 (기본 COOKIE_NAME).

    Returns:
        v1 caller_info dict.
    """
    if body_caller_info:
        return body_caller_info
    user = decode_dashboard_jwt_user(request, jwt_secret, cookie_name)
    if user is not None and not user.get("name"):
        return build_system_caller_info(node_id=system_node_id)
    return build_browser_caller_info(request, jwt_secret, cookie_name)


#: caller_info.source 중 *발신자 정체성을 자기 자신으로 명시한* source 집합.
#:
#: 이 source의 caller_info는 신원 필드(display_name/avatar_url)가 비어 있어도 정체성을 보존
#: — orch/soul-server enrichment 헬퍼는 owner/dash_user_*로 덮지 않으며, task_factory의
#: `_has_identity`는 True를 반환한다.
#:
#: R-2 (2026-05-10): agent/system/slack/soul-app 4 원소 — atom 0499ee7b 정본.
#: R-4 (atom G-13, 2026-05-11): channel_observer/trello_watcher/llm 명시 포함 (7 원소).
#: R-3 빌더 측 avatar_url truthy NOOP은 *우연 정합 의존* — §4 명시적 실패에 정합하지 않는다.
#: 본 상수가 *정체성 명시 source 의도*를 직접 표현한다.
#:
#: 사용 위치 (3 곳, §9 대칭):
#: - orch-server/.../api/session_serializer.py:apply_user_profile_enrichment
#: - soul-server/.../dashboard/user_profile.py:apply_dash_user_profile_enrichment
#: - soul-server/.../service/task_factory.py:_has_identity
IDENTITY_BEARING_SOURCES: frozenset[str] = frozenset({
    "agent",
    "system",
    "slack",
    "soul-app",
    "channel_observer",
    "trello_watcher",
    "llm",
})
