"""세션 인과(caller_session_id) wire 노출 — orch-server side 검증.

대응 atom 카드: project > soulstream > 작업 이력 > 260505.04.session-parent-tracking-wire
관련 분석 캐시: .local/artifacts/analysis/20260504-1657-session-parent-tracking.md

본 테스트가 검증하는 것:
- (g, h) _session_to_response()가 입력 dict의 caller_session_id (snake)를
       camelCase callerSessionId 키로 출력한다. None인 경우 None으로 보존.

orch-server REST 응답 컨벤션은 camelCase이므로 snake→camel 변환은 정상.
"""

from soulstream_server.api.session_serializer import _session_to_response


class TestSessionToResponseCallerSessionId:
    """_session_to_response — callerSessionId 키 노출"""

    def test_response_includes_caller_session_id_camel_case(self):
        """입력 dict의 caller_session_id가 callerSessionId로 변환되어 출력된다."""
        db_row = {
            "session_id": "sess-child",
            "status": "running",
            "session_type": "claude",
            "caller_session_id": "sess-parent-1",
            "metadata": [],
            "last_event_id": 0,
            "last_read_event_id": 0,
        }
        response = _session_to_response(db_row, node_manager=None)
        assert "callerSessionId" in response
        assert response["callerSessionId"] == "sess-parent-1"

    def test_response_includes_caller_session_id_none(self):
        """caller_session_id가 None인 세션은 callerSessionId 키 자체는 존재하고 값은 None이다."""
        db_row = {
            "session_id": "sess-direct",
            "status": "running",
            "session_type": "claude",
            "caller_session_id": None,
            "metadata": [],
            "last_event_id": 0,
            "last_read_event_id": 0,
        }
        response = _session_to_response(db_row, node_manager=None)
        assert "callerSessionId" in response
        assert response["callerSessionId"] is None

    def test_response_includes_caller_session_id_when_key_missing(self):
        """입력 dict에 caller_session_id 키 자체가 없어도 callerSessionId는 None으로 출력된다.

        호출자가 dict를 동적으로 구성하는 경우(메모리 재로드 등) 누락이 있을 수 있는데
        s.get("caller_session_id") 패턴으로 안전하게 None을 반환해야 한다.
        """
        db_row = {
            "session_id": "sess-legacy",
            "status": "completed",
            "session_type": "claude",
            "metadata": [],
            "last_event_id": 0,
            "last_read_event_id": 0,
        }
        response = _session_to_response(db_row, node_manager=None)
        assert "callerSessionId" in response
        assert response["callerSessionId"] is None
