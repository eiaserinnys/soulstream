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
