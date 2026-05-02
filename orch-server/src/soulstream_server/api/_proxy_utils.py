"""orch→soul HTTP 프록시 공용 헬퍼.

orch-server의 HTTP 프록시 핸들러들이 soul-server로 forward할 때
사용자 요청의 인증 헤더(Cookie/Authorization)를 그대로 전달하도록 돕는다.
"""

from fastapi import Request


def forward_auth_headers(request: Request) -> dict[str, str]:
    """대시보드 인증 헤더(Cookie/Authorization)를 발신 요청에서 추출.

    soul-server 측 ``require_dashboard_auth`` (Cookie 우선, Bearer 폴백) 또는
    ``verify_token``이 헤더를 인식할 수 있도록 forward한다.
    둘 다 없으면 빈 dict를 반환한다 — 인증 비활성 환경에서는
    soul-server의 ``require_dashboard_auth``가 None을 반환하므로
    빈 dict 전달도 안전하다.

    user-agent, x-forwarded-for 등 다른 헤더는 의도적으로 무시한다
    (orch가 보내는 외부 호출이므로 사용자 IP 헤더 등을 그대로 흘릴 이유 없음).
    """
    headers: dict[str, str] = {}
    cookie = request.headers.get("cookie")
    if cookie:
        headers["cookie"] = cookie
    authorization = request.headers.get("authorization")
    if authorization:
        headers["authorization"] = authorization
    return headers
