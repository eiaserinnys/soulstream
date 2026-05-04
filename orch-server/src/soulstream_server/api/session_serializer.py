"""
세션 DB 레코드 → API 응답 직렬화.

sessions.py, session_stream.py, catalog.py 등에서 공유하는
세션 응답 변환 함수와 portrait 프록시 URL 빌더를 제공한다.
"""

from typing import Optional

from soulstream_server.nodes.node_manager import NodeManager


def _build_portrait_proxy_url(source_node_id: str, agent_id: str) -> str:
    """에이전트 portrait 프록시 URL을 조립한다. (API 계층 전용)"""
    return f"/api/nodes/{source_node_id}/agents/{agent_id}/portrait"


def _build_user_portrait_proxy_url(node_id: str) -> str:
    """사용자 portrait 프록시 URL을 ��립한다. (API 계층 전용)"""
    return f"/api/nodes/{node_id}/user/portrait"


def _session_to_response(
    s: dict,
    node_manager: Optional[NodeManager] = None,
) -> dict:
    """DB 세션 레코드를 API 응답 형식으로 변환.

    node_manager가 제공되면 크로스-노드 에이전트 프로필 fallback을 사용한다.
    원격 노드(eias-linegames 등)의 agent_profiles가 비어있을 때
    다른 연결된 노드에서 같은 에이전트 프로필을 찾는다.
    """
    created_at = s.get("created_at")
    if hasattr(created_at, "isoformat"):
        created_at = created_at.isoformat()
    updated_at = s.get("updated_at")
    if hasattr(updated_at, "isoformat"):
        updated_at = updated_at.isoformat()

    result = {
        "agentSessionId": s.get("session_id"),
        "status": s.get("status"),
        "prompt": s.get("prompt"),
        "createdAt": created_at,
        "updatedAt": updated_at,
        "sessionType": s.get("session_type", "claude"),
        "lastMessage": s.get("last_message"),
        "clientId": s.get("client_id"),
        "metadata": s.get("metadata"),
        "displayName": s.get("display_name"),
        "nodeId": s.get("node_id"),
        "folderId": s.get("folder_id"),
        "lastEventId": s.get("last_event_id", 0),
        "lastReadEventId": s.get("last_read_event_id", 0),
        # 위임 세션의 부모 식별자. 직접 진입(브라우저/슬랙/외부 API)은 None.
        # 정본은 sessions.caller_session_id 컬럼 (snake_case → camelCase 변환).
        "callerSessionId": s.get("caller_session_id"),
        "agentId": s.get("agent_id"),
        "agentName": None,
        "agentPortraitUrl": None,
        "userName": None,
        "userPortraitUrl": None,
    }

    agent_id = s.get("agent_id")
    node_id = s.get("node_id")
    if agent_id and node_manager is not None:
        found = node_manager.find_agent_profile(agent_id, node_id)
        if found:
            profile, source_node_id = found
            result["agentName"] = profile.get("name")
            if profile.get("portrait_url") and source_node_id:
                result["agentPortraitUrl"] = _build_portrait_proxy_url(
                    source_node_id, agent_id
                )

    if node_id and node_manager is not None:
        user_info = node_manager.get_user_info(node_id)
        if user_info:
            result["userName"] = user_info.get("name")
            if user_info.get("hasPortrait"):
                result["userPortraitUrl"] = _build_user_portrait_proxy_url(node_id)

    return result
