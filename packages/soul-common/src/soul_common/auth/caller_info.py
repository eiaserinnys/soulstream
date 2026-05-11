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


def extract_caller_info_from_metadata(metadata) -> Optional[dict]:
    """세션 metadata JSONB array에서 첫 caller_info entry의 value(dict)를 반환.

    metadata는 PostgresSessionDB가 반환하는 list[{"type": str, "value": ...}] 형식.
    caller_info 통합 v1(atom ed3a216d) 정본 진입점.

    F-9 fix(2026-05-08)로 본 모듈에 통합. 이전엔 orch-server session_serializer에
    `_extract_caller_info`로 사본이 있었으나 soul-server eviction_manager의 caller_info
    복원에도 같은 로직이 필요해 정본 하나(design-principles §3)로 합쳤다.

    Args:
        metadata: 세션 DB row의 metadata 컬럼(list[dict] 또는 None).

    Returns:
        첫 caller_info entry의 value dict, 또는 None.
    """
    if not metadata:
        return None
    for m in metadata:
        if isinstance(m, dict) and m.get("type") == "caller_info":
            v = m.get("value")
            if isinstance(v, dict):
                return v
    return None


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
