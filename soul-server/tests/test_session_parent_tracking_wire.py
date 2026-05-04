"""세션 인과(caller_session_id) wire 노출 — soul-server side 검증.

대응 atom 카드: project > soulstream > 작업 이력 > 260505.04.session-parent-tracking-wire
관련 분석 캐시: .local/artifacts/analysis/20260504-1657-session-parent-tracking.md

본 테스트가 검증하는 것:
- (a, b) Task.to_session_info()가 caller_session_id를 1급 키로 노출한다.
       위임 세션이면 부모 ID를, 직접 세션이면 None을 반환한다.

caller_info에서 parent_session_id 키 제거(케이스 e, f)는 이미 기존 테스트
(test_agent_tools.py, test_phase2_multi_node.py)에 통합되어 있어 본 파일에서
중복하지 않는다.
"""

import pytest

from soul_server.service.task_models import Task


class TestToSessionInfoCallerSessionId:
    """to_session_info() — caller_session_id 키 노출"""

    def test_to_session_info_includes_caller_session_id_for_delegated_task(self):
        """위임으로 생성된 Task의 to_session_info에 caller_session_id가 부모 ID로 포함된다."""
        task = Task(
            agent_session_id="sess-child",
            prompt="sub task",
            caller_session_id="sess-parent-1",
        )
        info = task.to_session_info()
        assert "caller_session_id" in info
        assert info["caller_session_id"] == "sess-parent-1"

    def test_to_session_info_includes_caller_session_id_none_for_direct_task(self):
        """직접 생성된 Task(caller_session_id=None)의 to_session_info에 caller_session_id 키가 존재하며 None이다.

        브라우저/슬랙/외부 API 진입의 경우 caller_session_id가 None인데, 이때 키 자체가
        부재하면 클라이언트가 "해당 세션은 caller가 있는데 누락됨"으로 오해할 수 있다.
        키는 항상 존재하고 값만 None이라야 의미가 명확하다.
        """
        task = Task(
            agent_session_id="sess-direct",
            prompt="direct prompt",
            caller_session_id=None,
        )
        info = task.to_session_info()
        assert "caller_session_id" in info
        assert info["caller_session_id"] is None
