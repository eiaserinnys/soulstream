"""대시보드 user 프로필 enrichment 헬퍼.

R-3 fix(2026-05-08): soul-server 자체 대시보드(GET /api/sessions)가
caller_info 정체성을 무시하고 settings.dash_user_name/dash_user_portrait를
일괄 덮어쓰던 결함을 닫는다. caller_info가 채운 행은 보존하고, 부재 시에만
settings 기반으로 fallback한다.

orch-server `apply_user_profile_enrichment`(session_serializer.py)와
*동일 의미*의 정책을 따른다 — 정본 둘 안티패턴(atom d7a1ad86) 회피.
soul-server는 NodeManager 미인지(cross-node 의존 금지)이므로 settings를
user_info source로 사용한다 (orch가 NodeManager.get_user_info를 쓰는 것과 대칭).

호출 지점:
- dashboard/routes/sessions.py:api_get_sessions (GET /api/sessions)

관련 atom:
- 정책 정본: ed3a216d (caller_info 통합 스키마 v1)
- 정본 둘 안티패턴: d7a1ad86
- N.4 enrichment 변경 시 동시 갱신: 9d47010b
"""
from typing import Optional

from soul_common.auth.caller_info import IDENTITY_BEARING_SOURCES


def apply_dash_user_profile_enrichment(
    payload: dict,
    *,
    user_name: Optional[str],
    user_portrait_url: Optional[str],
    caller_source: Optional[str] = None,
    name_key: str = "userName",
    portrait_key: str = "userPortraitUrl",
) -> None:
    """payload[name_key]가 비어있으면 settings 기반 dash user 프로필로 fallback (in-place).

    R-2 fix(2026-05-10): caller_source가 정체성 명시 source(agent/system/slack/soul-app)면
    신원 필드 값에 무관하게 즉시 NOOP. orch `apply_user_profile_enrichment`와 §9 대칭 —
    G-2 회로(atom 0499ee7b)를 soul-server 자체 대시보드에서도 닫는다.

    R-4 fix(2026-05-11, atom G-13): IDENTITY_BEARING_SOURCES를 soul_common 정본으로 추출.
    봇/llm source 명시 포함 (7 원소) — 우연 정합 의존 제거, §4 명시적 실패 정합.

    정책 — caller_info 정체성 우선, mix-fallback 금지(atom ed3a216d v1):
    - caller_source ∈ IDENTITY_BEARING_SOURCES(7 원소) → NOOP (R-2 + R-4)
    - payload[name_key] *또는* payload[portrait_key] truthy → NOOP
      (caller_info 정체성 부분이라도 있으면 보존 — name만 있거나 portrait만
      있어도 settings 정보로 덮지 않음)
    - user_name 빈 값(None/"") → NOOP (graceful — settings.dash_user_name 미설정)

    적용 후 동작 (NOOP 아닌 분기):
    - user_name 있고 user_portrait_url 있음 → 둘 다 채움
    - user_name 있고 user_portrait_url 없음 → name만 채움 (portrait는 None 유지)
    """
    # R-2 + R-4: 정체성 명시 source는 settings 정보로 덮지 않음.
    if caller_source in IDENTITY_BEARING_SOURCES:
        return
    if (
        payload.get(name_key)
        or payload.get(portrait_key)
        or not user_name
    ):
        return
    payload[name_key] = user_name
    if user_portrait_url:
        payload[portrait_key] = user_portrait_url
