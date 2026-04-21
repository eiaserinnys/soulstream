"""세션 컨텍스트 조립

Claude Code 세션에 전달할 소울스트림 메타데이터 context_item 생성과
context_items를 XML 블록으로 직렬화하는 순수 함수들.
"""

import json
import platform
import re
import socket
from datetime import datetime, timezone
from typing import List, Optional

from soul_server.config import get_settings


def build_soulstream_context_item(
    agent_session_id: str,
    claude_session_id: Optional[str],
    workspace_dir: str,
    folder_name: Optional[str] = None,
    node_id: Optional[str] = None,
    agent_id: Optional[str] = None,
    caller_info: Optional[dict] = None,
) -> dict:
    """소울스트림 자체 세션 메타데이터 context_item을 생성한다.

    caller_info: 발신자 정보 dict. None이면 content dict에서 생략된다.
    """
    hostname = socket.gethostname()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
    except Exception:
        ip = "unknown"

    host_os = platform.system()
    os_version = platform.version()

    resolved_node_id = node_id
    if resolved_node_id is None:
        try:
            resolved_node_id = get_settings().soulstream_node_id or ""
        except Exception:
            resolved_node_id = ""

    content = {
        "agent_session_id": agent_session_id,
        "claude_session_id": claude_session_id if claude_session_id else "(new session)",
        "workspace_dir": workspace_dir,
        "folder": folder_name or "(unassigned)",
        "hostname": hostname,
        "ip_address": ip,
        "current_node_id": resolved_node_id,
        "host_os": host_os,
        "os_version": os_version,
        "current_time": datetime.now(timezone.utc).isoformat(),
    }
    if agent_id:
        content["agent_id"] = agent_id
    if caller_info:
        content["caller_info"] = caller_info
    return {
        "key": "soulstream_session",
        "label": "Soulstream 세션 정보",
        "content": content,
    }


def format_context_items(context_items: List[dict]) -> str:
    """context_items를 Claude Code가 읽을 수 있는 XML 블록으로 직렬화한다."""
    parts = []
    for item in context_items:
        raw_key = item.get("key", "item")
        # XML 태그명으로 안전한 문자만 허용 (영문/숫자/밑줄)
        key = re.sub(r'[^a-zA-Z0-9_]', '_', raw_key) or "item"
        content = item.get("content", "")
        if isinstance(content, (dict, list)):
            content_str = json.dumps(content, ensure_ascii=False, indent=2)
        else:
            content_str = str(content)
        parts.append(f"<{key}>\n{content_str}\n</{key}>")
    return "<context>\n" + "\n".join(parts) + "\n</context>"
