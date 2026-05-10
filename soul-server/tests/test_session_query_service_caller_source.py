"""test_session_query_service_caller_source — R-2 _build_session_dict caller_source promote 회귀.

R-2 fix(2026-05-10) — atom 0499ee7b (G-2):
- `_build_session_dict`이 caller_info의 source를 entry["caller_source"]로 promote.
- _query.py:api_get_sessions가 `entry.get("caller_source")`를 헬퍼에 forward하여
  정체성 명시 source가 settings.dash_user_*로 덮이지 않게 한다.

키 이름은 orch SSE wire의 top-level caller_source와 동일 (§3 정본 하나).
"""
import pytest

from soul_server.service.session_query_service import _build_session_dict


def _row(metadata=None, **kwargs):
    base = {
        "session_id": "sess-1",
        "status": "running",
        "prompt": "테스트",
        "session_type": "claude",
        "metadata": metadata or [],
        "node_id": None,
        "agent_id": None,
    }
    base.update(kwargs)
    return base


class TestBuildSessionDictCallerSource:
    @pytest.mark.parametrize(
        "source",
        ["agent", "system", "slack", "soul-app", "browser", "api"],
    )
    def test_caller_source_promoted_to_entry(self, source):
        """모든 v1 source가 entry['caller_source']로 promote된다."""
        row = _row(metadata=[
            {"type": "caller_info", "value": {
                "source": source,
                "display_name": "X" if source != "agent" else None,
            }},
        ])
        info = _build_session_dict(row)
        assert info["caller_source"] == source

    def test_no_caller_info_no_caller_source_key(self):
        """metadata에 caller_info entry 없음 → entry에 caller_source 키 부재."""
        info = _build_session_dict(_row(metadata=[]))
        assert "caller_source" not in info

    def test_caller_info_without_source_no_caller_source_key(self):
        """caller_info dict에 source 키 부재 → entry에 caller_source 키 부재."""
        row = _row(metadata=[
            {"type": "caller_info", "value": {"display_name": "Eve"}},
        ])
        info = _build_session_dict(row)
        assert "caller_source" not in info
        # display_name은 promote
        assert info["userName"] == "Eve"

    def test_caller_info_empty_source_string_no_caller_source_key(self):
        """source 값이 빈 문자열 → entry에 caller_source 키 부재 (isinstance + truthy 가드)."""
        row = _row(metadata=[
            {"type": "caller_info", "value": {"source": "", "display_name": "Eve"}},
        ])
        info = _build_session_dict(row)
        assert "caller_source" not in info

    def test_agent_source_with_empty_identity_promotes_source(self):
        """agent source의 신원 부재여도 source는 entry에 promote — _query.py에서 헬퍼 NOOP에 forward 가능."""
        row = _row(metadata=[
            {"type": "caller_info", "value": {
                "source": "agent",
                "agent_node": "node-1",
                "agent_id": "ag-x",
            }},
        ])
        info = _build_session_dict(row)
        assert info["caller_source"] == "agent"
        # 신원 부재이므로 userName/userPortraitUrl은 None
        assert info["userName"] is None
        assert info["userPortraitUrl"] is None
