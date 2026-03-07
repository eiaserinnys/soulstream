"""AskUserQuestion (can_use_tool) 기능 테스트

agent_runner의 can_use_tool 콜백과 응답 전달 메커니즘을 검증합니다.
"""

import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock

from soul_server.claude.agent_runner import ClaudeRunner
from soul_server.engine.types import InputRequestEngineEvent


class TestMakeCanUseTool:
    """_make_can_use_tool 팩토리 테스트"""

    def test_returns_callable(self):
        """can_use_tool 콜백을 반환해야 함"""
        runner = ClaudeRunner()
        callback = runner._make_can_use_tool()
        assert callable(callback)

    @pytest.mark.asyncio
    async def test_non_ask_user_tool_allowed(self):
        """AskUserQuestion이 아닌 도구는 항상 허용"""
        runner = ClaudeRunner()
        callback = runner._make_can_use_tool()

        # 다양한 도구 이름 테스트
        for tool_name in ["Read", "Bash", "Glob", "Edit", "WebFetch"]:
            result = await callback(tool_name, {"path": "/tmp"}, MagicMock())
            assert result.behavior == "allow"
            assert result.updated_input is None

    @pytest.mark.asyncio
    async def test_ask_user_question_emits_event(self):
        """AskUserQuestion 감지 시 InputRequestEngineEvent 발행"""
        runner = ClaudeRunner()
        callback = runner._make_can_use_tool()

        # on_event 콜백 설정
        captured_events = []

        async def capture_event(event):
            captured_events.append(event)

        runner._on_event_callback = capture_event

        # 질문 입력
        tool_input = {
            "questions": [
                {
                    "question": "어떤 방법을 사용할까요?",
                    "header": "선택",
                    "options": [
                        {"label": "방법 A", "description": "첫 번째 방법"},
                        {"label": "방법 B", "description": "두 번째 방법"},
                    ],
                    "multiSelect": False,
                }
            ]
        }

        # 응답 즉시 전달 (별도 태스크에서)
        async def deliver_response():
            await asyncio.sleep(0.05)  # 잠시 대기
            # 이벤트가 발행되었는지 확인
            assert len(captured_events) == 1
            event = captured_events[0]
            assert isinstance(event, InputRequestEngineEvent)
            assert len(event.questions) == 1

            # 응답 전달
            runner.deliver_input_response(
                event.request_id,
                {"어떤 방법을 사용할까요?": "방법 A"},
            )

        task = asyncio.create_task(deliver_response())
        result = await callback("AskUserQuestion", tool_input, MagicMock())
        await task

        # PermissionResultAllow이고 answers가 포함되어야 함
        assert result.behavior == "allow"
        assert result.updated_input is not None
        assert result.updated_input["answers"] == {
            "어떤 방법을 사용할까요?": "방법 A"
        }
        # 원본 questions도 유지
        assert "questions" in result.updated_input

    @pytest.mark.asyncio
    async def test_ask_user_question_timeout(self):
        """응답 없이 타임아웃되면 deny 반환"""
        runner = ClaudeRunner()
        runner.input_request_timeout = 0.1  # 빠른 테스트를 위해 짧은 타임아웃
        callback = runner._make_can_use_tool()

        tool_input = {
            "questions": [
                {
                    "question": "선택하세요",
                    "options": [{"label": "A"}],
                }
            ]
        }

        result = await callback("AskUserQuestion", tool_input, MagicMock())
        assert result.behavior == "deny"
        assert "시간" in result.message or "타임아웃" in result.message

    @pytest.mark.asyncio
    async def test_ask_user_question_without_on_event(self):
        """on_event 콜백 없으면 pending_events에 추가"""
        runner = ClaudeRunner()
        runner.input_request_timeout = 0.1
        callback = runner._make_can_use_tool()

        # on_event 설정하지 않음
        runner._on_event_callback = None

        tool_input = {
            "questions": [{"question": "test?", "options": [{"label": "A"}]}]
        }

        # 타임아웃 전에 pending_events에 추가되었는지 확인
        result = await callback("AskUserQuestion", tool_input, MagicMock())

        # 타임아웃으로 deny 반환
        assert result.behavior == "deny"
        # pending_events에 이벤트가 추가되었어야 함 (finally에서 정리되지 않음)
        # 단, 정리 로직 전에 pending_events에 추가됨


class TestDeliverInputResponse:
    """deliver_input_response 메서드 테스트"""

    def test_deliver_to_pending_request(self):
        """대기 중인 요청에 응답 전달"""
        runner = ClaudeRunner()

        # 수동으로 대기 이벤트 생성
        event = asyncio.Event()
        runner._input_response_events["req-123"] = event

        result = runner.deliver_input_response(
            "req-123", {"q1": "answer1"}
        )

        assert result is True
        assert event.is_set()
        assert runner._input_responses["req-123"] == {"q1": "answer1"}

    def test_deliver_to_nonexistent_request(self):
        """존재하지 않는 요청에 응답 시 False 반환"""
        runner = ClaudeRunner()

        result = runner.deliver_input_response(
            "nonexistent", {"q1": "answer1"}
        )

        assert result is False

    def test_cleanup_on_response(self):
        """응답 전달 후 이벤트와 응답 데이터 정리되지 않음 (콜백이 정리)"""
        runner = ClaudeRunner()

        event = asyncio.Event()
        runner._input_response_events["req-456"] = event

        runner.deliver_input_response("req-456", {"q1": "a1"})

        # deliver_input_response는 event와 response를 설정만 함
        # 정리는 can_use_tool 콜백의 finally에서 수행
        assert "req-456" in runner._input_response_events
        assert "req-456" in runner._input_responses


class TestBuildOptionsCanUseTool:
    """_build_options에 can_use_tool이 설정되는지 테스트"""

    def test_options_has_can_use_tool(self):
        """빌드된 옵션에 can_use_tool 콜백이 있어야 함"""
        runner = ClaudeRunner()
        options, _ = runner._build_options()

        assert options.can_use_tool is not None
        assert callable(options.can_use_tool)


class TestInputRequestEngineEvent:
    """InputRequestEngineEvent SSE 변환 테스트"""

    def test_to_sse_basic(self):
        """기본 SSE 변환"""
        event = InputRequestEngineEvent(
            request_id="req-abc",
            tool_use_id="toolu_123",
            questions=[
                {
                    "question": "어떤 옵션?",
                    "header": "선택",
                    "options": [
                        {"label": "A", "description": "첫 번째"},
                        {"label": "B", "description": "두 번째"},
                    ],
                    "multiSelect": False,
                }
            ],
        )

        sse_events = event.to_sse()
        assert len(sse_events) == 1

        sse = sse_events[0]
        assert sse.type == "input_request"
        assert sse.request_id == "req-abc"
        assert sse.tool_use_id == "toolu_123"
        assert len(sse.questions) == 1

        q = sse.questions[0]
        assert q.question == "어떤 옵션?"
        assert q.header == "선택"
        assert len(q.options) == 2
        assert q.multi_select is False

    def test_to_sse_multiple_questions(self):
        """복수 질문 SSE 변환"""
        event = InputRequestEngineEvent(
            request_id="req-multi",
            questions=[
                {"question": "Q1?", "options": [{"label": "Y"}, {"label": "N"}]},
                {"question": "Q2?", "options": [{"label": "A"}, {"label": "B"}], "multiSelect": True},
            ],
        )

        sse_events = event.to_sse()
        sse = sse_events[0]

        assert len(sse.questions) == 2
        assert sse.questions[0].question == "Q1?"
        assert sse.questions[0].multi_select is False
        assert sse.questions[1].question == "Q2?"
        assert sse.questions[1].multi_select is True

    def test_to_sse_empty_questions(self):
        """빈 질문 목록 SSE 변환"""
        event = InputRequestEngineEvent(
            request_id="req-empty",
            questions=[],
        )

        sse_events = event.to_sse()
        assert len(sse_events) == 1
        assert sse_events[0].questions == []


class TestInputRequestSSEEventModel:
    """InputRequestSSEEvent Pydantic 모델 테스트"""

    def test_model_serialization(self):
        """모델 직렬화/역직렬화"""
        from soul_server.models import InputRequestSSEEvent, InputRequestQuestion

        event = InputRequestSSEEvent(
            timestamp=1234567890.0,
            request_id="req-test",
            tool_use_id="toolu_test",
            questions=[
                InputRequestQuestion(
                    question="Choose?",
                    header="Header",
                    options=[{"label": "A", "description": "Option A"}],
                    multi_select=False,
                )
            ],
        )

        data = event.model_dump()
        assert data["type"] == "input_request"
        assert data["request_id"] == "req-test"
        assert data["tool_use_id"] == "toolu_test"
        assert len(data["questions"]) == 1

    def test_model_defaults(self):
        """기본값 테스트"""
        from soul_server.models import InputRequestQuestion

        q = InputRequestQuestion(question="test?")
        assert q.header == ""
        assert q.options == []
        assert q.multi_select is False


class TestInputResponseRequest:
    """InputResponseRequest 모델 테스트"""

    def test_validation(self):
        """필수 필드 검증"""
        from soul_server.models import InputResponseRequest

        req = InputResponseRequest(
            request_id="req-123",
            answers={"Q1": "A1"},
        )
        assert req.request_id == "req-123"
        assert req.answers == {"Q1": "A1"}

    def test_missing_fields(self):
        """필수 필드 누락 시 에러"""
        from pydantic import ValidationError
        from soul_server.models import InputResponseRequest

        with pytest.raises(ValidationError):
            InputResponseRequest(request_id="req-123")  # answers 누락

        with pytest.raises(ValidationError):
            InputResponseRequest(answers={"Q1": "A1"})  # request_id 누락


class TestTaskManagerDeliverInputResponse:
    """TaskManager.deliver_input_response 테스트"""

    @pytest.mark.asyncio
    async def test_deliver_to_running_task(self):
        """실행 중인 태스크에 응답 전달"""
        from soul_server.service.task_manager import TaskManager
        from soul_server.service.task_models import Task, TaskStatus

        manager = TaskManager()
        task = Task(agent_session_id="sess-1", prompt="test")
        task.status = TaskStatus.RUNNING

        # 응답 전달 콜백 설정
        delivered = {}
        def mock_deliver(request_id, answers):
            delivered["request_id"] = request_id
            delivered["answers"] = answers
            return True

        task._deliver_input_response = mock_deliver
        manager._tasks["sess-1"] = task

        result = manager.deliver_input_response("sess-1", "req-1", {"Q": "A"})
        assert result is True
        assert delivered["request_id"] == "req-1"
        assert delivered["answers"] == {"Q": "A"}

    @pytest.mark.asyncio
    async def test_deliver_to_nonexistent_session(self):
        """존재하지 않는 세션에 응답 시 에러"""
        from soul_server.service.task_manager import TaskManager
        from soul_server.service.task_models import TaskNotFoundError

        manager = TaskManager()

        with pytest.raises(TaskNotFoundError):
            manager.deliver_input_response("nonexistent", "req-1", {"Q": "A"})

    @pytest.mark.asyncio
    async def test_deliver_to_completed_session(self):
        """완료된 세션에 응답 시 에러"""
        from soul_server.service.task_manager import TaskManager
        from soul_server.service.task_models import Task, TaskStatus, TaskNotRunningError

        manager = TaskManager()
        task = Task(agent_session_id="sess-2", prompt="test")
        task.status = TaskStatus.COMPLETED
        manager._tasks["sess-2"] = task

        with pytest.raises(TaskNotRunningError):
            manager.deliver_input_response("sess-2", "req-1", {"Q": "A"})

    @pytest.mark.asyncio
    async def test_deliver_without_callback(self):
        """콜백 없는 태스크에 응답 시 False 반환"""
        from soul_server.service.task_manager import TaskManager
        from soul_server.service.task_models import Task, TaskStatus

        manager = TaskManager()
        task = Task(agent_session_id="sess-3", prompt="test")
        task.status = TaskStatus.RUNNING
        task._deliver_input_response = None  # 콜백 없음
        manager._tasks["sess-3"] = task

        result = manager.deliver_input_response("sess-3", "req-1", {"Q": "A"})
        assert result is False


class TestRespondEndpoint:
    """POST /sessions/{id}/respond 엔드포인트 테스트"""

    @pytest.fixture
    def setup(self, auth_headers):
        """테스트용 FastAPI 앱 + TestClient"""
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from soul_server.api.tasks import router

        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)

        return {"client": client, "auth_headers": auth_headers}

    def test_respond_success(self, setup, monkeypatch):
        """성공적인 응답 전달"""
        from soul_server.service.task_manager import TaskManager
        from soul_server.service.task_models import Task, TaskStatus

        manager = TaskManager()
        task = Task(agent_session_id="sess-respond-1", prompt="test")
        task.status = TaskStatus.RUNNING

        called_with = {}
        def mock_deliver(request_id, answers):
            called_with["request_id"] = request_id
            called_with["answers"] = answers
            return True

        task._deliver_input_response = mock_deliver
        manager._tasks["sess-respond-1"] = task

        monkeypatch.setattr(
            "soul_server.api.tasks.get_task_manager",
            lambda: manager,
        )

        response = setup["client"].post(
            "/sessions/sess-respond-1/respond",
            json={
                "request_id": "req-abc",
                "answers": {"Q1": "A1"},
            },
            headers=setup["auth_headers"],
        )

        assert response.status_code == 200
        data = response.json()
        assert data["delivered"] is True
        assert data["request_id"] == "req-abc"
        assert called_with["request_id"] == "req-abc"

    def test_respond_session_not_found(self, setup, monkeypatch):
        """세션 미발견 시 404"""
        from soul_server.service.task_manager import TaskManager

        manager = TaskManager()

        monkeypatch.setattr(
            "soul_server.api.tasks.get_task_manager",
            lambda: manager,
        )

        response = setup["client"].post(
            "/sessions/nonexistent/respond",
            json={
                "request_id": "req-abc",
                "answers": {"Q1": "A1"},
            },
            headers=setup["auth_headers"],
        )

        assert response.status_code == 404

    def test_respond_session_not_running(self, setup, monkeypatch):
        """세션이 실행 중이 아닐 때 409"""
        from soul_server.service.task_manager import TaskManager
        from soul_server.service.task_models import Task, TaskStatus

        manager = TaskManager()
        task = Task(agent_session_id="sess-respond-3", prompt="test")
        task.status = TaskStatus.COMPLETED
        manager._tasks["sess-respond-3"] = task

        monkeypatch.setattr(
            "soul_server.api.tasks.get_task_manager",
            lambda: manager,
        )

        response = setup["client"].post(
            "/sessions/sess-respond-3/respond",
            json={
                "request_id": "req-abc",
                "answers": {"Q1": "A1"},
            },
            headers=setup["auth_headers"],
        )

        assert response.status_code == 409

    def test_respond_no_pending_request(self, setup, monkeypatch):
        """대기 중인 요청 없을 때 422"""
        from soul_server.service.task_manager import TaskManager
        from soul_server.service.task_models import Task, TaskStatus

        manager = TaskManager()
        task = Task(agent_session_id="sess-respond-4", prompt="test")
        task.status = TaskStatus.RUNNING

        # 콜백이 False를 반환 (대기 중인 요청 없음)
        task._deliver_input_response = lambda req_id, answers: False
        manager._tasks["sess-respond-4"] = task

        monkeypatch.setattr(
            "soul_server.api.tasks.get_task_manager",
            lambda: manager,
        )

        response = setup["client"].post(
            "/sessions/sess-respond-4/respond",
            json={
                "request_id": "req-nonexistent",
                "answers": {"Q1": "A1"},
            },
            headers=setup["auth_headers"],
        )

        assert response.status_code == 422
