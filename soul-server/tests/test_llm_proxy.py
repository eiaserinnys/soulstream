"""
LLM Proxy - 유닛 테스트

LLM 프록시 API의 각 계층을 테스트합니다:
1. Pydantic 스키마 검증
2. LlmExecutor 로직
3. API 엔드포인트 통합
"""

import asyncio
import json
import time
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient, ASGITransport

from soul_server.models.llm import (
    LlmMessage,
    LlmCompletionRequest,
    LlmCompletionResponse,
)
from soul_server.llm.adapters import LlmResult, LlmAdapter
from soul_server.llm.executor import LlmExecutor
from soul_server.service.task_models import Task, TaskStatus
from soul_server.service.task_manager import TaskManager
from soul_server.service.postgres_session_db import PostgresSessionDB
from soul_server.service.session_broadcaster import SessionBroadcaster


# === Pydantic Schema Tests ===


class TestLlmSchemas:
    """Pydantic 스키마 검증"""

    def test_llm_message_valid(self):
        msg = LlmMessage(role="user", content="Hello")
        assert msg.role == "user"
        assert msg.content == "Hello"

    def test_llm_message_invalid_role(self):
        with pytest.raises(Exception):
            LlmMessage(role="invalid", content="Hello")

    def test_completion_request_defaults(self):
        req = LlmCompletionRequest(
            provider="openai",
            model="gpt-4o-mini",
            messages=[LlmMessage(role="user", content="Hello")],
        )
        assert req.max_tokens == 2048
        assert req.temperature is None
        assert req.client_id is None

    def test_completion_request_full(self):
        req = LlmCompletionRequest(
            provider="anthropic",
            model="claude-3-5-haiku-latest",
            messages=[
                LlmMessage(role="system", content="You are helpful."),
                LlmMessage(role="user", content="Hello"),
            ],
            max_tokens=1024,
            temperature=0.7,
            client_id="translate",
        )
        assert req.provider == "anthropic"
        assert req.max_tokens == 1024
        assert req.temperature == 0.7
        assert req.client_id == "translate"
        assert len(req.messages) == 2

    def test_completion_request_invalid_provider(self):
        with pytest.raises(Exception):
            LlmCompletionRequest(
                provider="google",
                model="gemini",
                messages=[LlmMessage(role="user", content="Hello")],
            )

    def test_completion_response(self):
        resp = LlmCompletionResponse(
            session_id="llm-20260310-abc12345",
            content="Hello!",
            usage={"input_tokens": 10, "output_tokens": 5},
            model="gpt-4o-mini",
            provider="openai",
        )
        assert resp.session_id.startswith("llm-")
        assert resp.content == "Hello!"
        assert resp.usage["input_tokens"] == 10


# === Mock Adapter ===


class MockAdapter:
    """테스트용 LLM 어댑터"""

    def __init__(self, content: str = "Mock response", input_tokens: int = 10, output_tokens: int = 5):
        self._content = content
        self._input_tokens = input_tokens
        self._output_tokens = output_tokens
        self.call_count = 0
        self.last_call_args = None

    async def complete(self, model, messages, max_tokens, temperature):
        self.call_count += 1
        self.last_call_args = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        return LlmResult(
            content=self._content,
            input_tokens=self._input_tokens,
            output_tokens=self._output_tokens,
        )


class FailingAdapter:
    """실패하는 LLM 어댑터"""

    async def complete(self, model, messages, max_tokens, temperature):
        raise RuntimeError("API call failed: rate limited")


# === Executor Tests ===


def _make_mock_session_db():
    """PostgresSessionDB의 AsyncMock을 생성한다."""
    db = AsyncMock(spec=PostgresSessionDB)
    db.upsert_session = AsyncMock()
    db.get_session = AsyncMock(return_value=None)
    db.get_all_sessions = AsyncMock(return_value=([], 0))
    db.append_event = AsyncMock(return_value=1)
    db.ensure_default_folders = AsyncMock()
    db.get_default_folder = AsyncMock(return_value={"id": "claude", "name": "클로드 코드 세션"})
    db.assign_session_to_folder = AsyncMock()
    db.get_catalog = AsyncMock(return_value={"folders": [], "sessions": {}})
    db.read_events = AsyncMock(return_value=[])
    db.extract_searchable_text = PostgresSessionDB.extract_searchable_text
    return db


@pytest.fixture
def session_db():
    return _make_mock_session_db()


@pytest.fixture
def task_manager(session_db):
    return TaskManager(
        session_db=session_db,
    )


@pytest.fixture
def broadcaster():
    from soul_server.service.session_broadcaster import set_session_broadcaster
    b = SessionBroadcaster()
    set_session_broadcaster(b)
    yield b
    set_session_broadcaster(None)


@pytest.fixture
def mock_adapter():
    return MockAdapter()


@pytest.fixture
def failing_adapter():
    return FailingAdapter()


@pytest.fixture
def executor(mock_adapter, task_manager, session_db, broadcaster):
    return LlmExecutor(
        adapters={"openai": mock_adapter},
        task_manager=task_manager,
        session_db=session_db,
        session_broadcaster=broadcaster,
    )


@pytest.fixture
def executor_with_both(mock_adapter, task_manager, session_db, broadcaster):
    return LlmExecutor(
        adapters={
            "openai": mock_adapter,
            "anthropic": MockAdapter(content="Anthropic response", input_tokens=15, output_tokens=8),
        },
        task_manager=task_manager,
        session_db=session_db,
        session_broadcaster=broadcaster,
    )


@pytest.fixture
def executor_with_failing(failing_adapter, task_manager, session_db, broadcaster):
    return LlmExecutor(
        adapters={"openai": failing_adapter},
        task_manager=task_manager,
        session_db=session_db,
        session_broadcaster=broadcaster,
    )


class TestLlmExecutor:
    """LlmExecutor 로직 테스트"""

    async def test_execute_openai_success(self, executor, mock_adapter):
        request = LlmCompletionRequest(
            provider="openai",
            model="gpt-4o-mini",
            messages=[LlmMessage(role="user", content="Hello")],
        )

        response = await executor.execute(request)

        assert response.session_id.startswith("llm-")
        assert response.content == "Mock response"
        assert response.usage == {"input_tokens": 10, "output_tokens": 5}
        assert response.model == "gpt-4o-mini"
        assert response.provider == "openai"
        assert mock_adapter.call_count == 1

    async def test_execute_with_client_id(self, executor, mock_adapter):
        request = LlmCompletionRequest(
            provider="openai",
            model="gpt-4o-mini",
            messages=[LlmMessage(role="user", content="Translate this")],
            client_id="translate",
        )

        response = await executor.execute(request)
        assert response.session_id.startswith("llm-")

        # client_id가 Task에 설정되었는지 확인
        task = executor._task_manager._tasks[response.session_id]
        assert task.client_id == "translate"

    async def test_execute_anthropic_success(self, executor_with_both):
        request = LlmCompletionRequest(
            provider="anthropic",
            model="claude-3-5-haiku-latest",
            messages=[LlmMessage(role="user", content="Hello")],
        )

        response = await executor_with_both.execute(request)

        assert response.content == "Anthropic response"
        assert response.usage == {"input_tokens": 15, "output_tokens": 8}
        assert response.provider == "anthropic"

    async def test_execute_unconfigured_provider(self, executor):
        request = LlmCompletionRequest(
            provider="anthropic",
            model="claude-3-5-haiku-latest",
            messages=[LlmMessage(role="user", content="Hello")],
        )

        with pytest.raises(ValueError, match="not configured"):
            await executor.execute(request)

    async def test_execute_creates_task(self, executor, task_manager):
        request = LlmCompletionRequest(
            provider="openai",
            model="gpt-4o-mini",
            messages=[LlmMessage(role="user", content="Hello")],
        )

        response = await executor.execute(request)

        # 세션이 등록되었는지 확인
        task = task_manager._tasks.get(response.session_id)
        assert task is not None
        assert task.session_type == "llm"
        assert task.llm_provider == "openai"
        assert task.llm_model == "gpt-4o-mini"
        assert task.status == TaskStatus.COMPLETED
        assert task.llm_usage == {"input_tokens": 10, "output_tokens": 5}

    async def test_execute_stores_events(self, executor, session_db):
        request = LlmCompletionRequest(
            provider="openai",
            model="gpt-4o-mini",
            messages=[LlmMessage(role="user", content="Hello")],
        )

        response = await executor.execute(request)

        # 이벤트가 append_event로 기록되었는지 확인 (2회: request + response)
        assert session_db.append_event.call_count == 2

        # 요청 이벤트
        first_call_payload = json.loads(session_db.append_event.call_args_list[0][0][2])
        assert first_call_payload["type"] == "user_message"
        assert first_call_payload["provider"] == "openai"
        assert first_call_payload["model"] == "gpt-4o-mini"

        # 응답 이벤트
        second_call_payload = json.loads(session_db.append_event.call_args_list[1][0][2])
        assert second_call_payload["type"] == "assistant_message"
        assert second_call_payload["content"] == "Mock response"
        assert second_call_payload["usage"] == {"input_tokens": 10, "output_tokens": 5}

    async def test_execute_api_error(self, executor_with_failing, session_db, task_manager):
        request = LlmCompletionRequest(
            provider="openai",
            model="gpt-4o-mini",
            messages=[LlmMessage(role="user", content="Hello")],
        )

        with pytest.raises(RuntimeError, match="rate limited"):
            await executor_with_failing.execute(request)

        # 에러 태스크가 등록되었는지 확인
        tasks_with_error = [
            t for t in task_manager._tasks.values()
            if t.status == TaskStatus.ERROR
        ]
        assert len(tasks_with_error) == 1
        assert "rate limited" in tasks_with_error[0].error

        # 에러 이벤트가 기록되었는지 확인 (append_event 2회: request + error)
        assert session_db.append_event.call_count == 2
        error_payload = json.loads(session_db.append_event.call_args_list[1][0][2])
        assert error_payload["type"] == "error"

    async def test_execute_broadcasts_session(self, executor, broadcaster):
        # 클라이언트 큐 등록
        queue = broadcaster.add_client()

        request = LlmCompletionRequest(
            provider="openai",
            model="gpt-4o-mini",
            messages=[LlmMessage(role="user", content="Hello")],
        )

        await executor.execute(request)

        # catalog_updated + session_created + session_updated 이벤트
        events = []
        while not queue.empty():
            events.append(queue.get_nowait())

        event_types = [e["type"] for e in events]
        assert "session_created" in event_types
        assert "session_updated" in event_types


# === Task Model Serialization Tests ===


class TestTaskModelSerialization:
    """Task 데이터 모델의 LLM 필드 직렬화/역직렬화 테스트"""

    def test_to_dict_with_llm_fields(self):
        task = Task(
            agent_session_id="llm-20260310-abc12345",
            prompt="Hello",
            status=TaskStatus.COMPLETED,
            session_type="llm",
            llm_provider="openai",
            llm_model="gpt-4o-mini",
            llm_usage={"input_tokens": 10, "output_tokens": 5},
        )
        d = task.to_dict()
        assert d["session_type"] == "llm"
        assert d["llm_provider"] == "openai"
        assert d["llm_model"] == "gpt-4o-mini"
        assert d["llm_usage"] == {"input_tokens": 10, "output_tokens": 5}

    def test_from_dict_with_llm_fields(self):
        data = {
            "agent_session_id": "llm-20260310-abc12345",
            "prompt": "Hello",
            "status": "completed",
            "session_type": "llm",
            "llm_provider": "anthropic",
            "llm_model": "claude-3-5-haiku-latest",
            "llm_usage": {"input_tokens": 15, "output_tokens": 8},
            "created_at": "2026-03-10T12:00:00+00:00",
        }
        task = Task.from_dict(data)
        assert task.session_type == "llm"
        assert task.llm_provider == "anthropic"
        assert task.llm_model == "claude-3-5-haiku-latest"
        assert task.llm_usage == {"input_tokens": 15, "output_tokens": 8}

    def test_from_dict_backward_compatible(self):
        """기존 데이터(session_type 없음)에서 복원 시 기본값"""
        data = {
            "agent_session_id": "sess-20260310-abc12345",
            "prompt": "Hello",
            "status": "completed",
            "created_at": "2026-03-10T12:00:00+00:00",
        }
        task = Task.from_dict(data)
        assert task.session_type == "claude"
        assert task.llm_provider is None
        assert task.llm_model is None
        assert task.llm_usage is None

    def test_roundtrip(self):
        """to_dict → from_dict 라운드트립"""
        original = Task(
            agent_session_id="llm-20260310-abc12345",
            prompt="Translate",
            status=TaskStatus.COMPLETED,
            client_id="translate",
            session_type="llm",
            llm_provider="openai",
            llm_model="gpt-4o-mini",
            llm_usage={"input_tokens": 100, "output_tokens": 50},
        )
        data = original.to_dict()
        restored = Task.from_dict(data)

        assert restored.agent_session_id == original.agent_session_id
        assert restored.session_type == original.session_type
        assert restored.llm_provider == original.llm_provider
        assert restored.llm_model == original.llm_model
        assert restored.llm_usage == original.llm_usage
        assert restored.client_id == original.client_id


# === API Integration Tests ===


class TestLlmAPI:
    """LLM API 엔드포인트 통합 테스트"""

    @pytest.fixture
    def app_with_llm(self):
        """LLM 프록시가 설정된 FastAPI 앱"""
        from fastapi import FastAPI
        from soul_server.api.llm import create_llm_router
        from soul_server.service.session_broadcaster import set_session_broadcaster

        mock_db = _make_mock_session_db()
        task_manager = TaskManager(
            session_db=mock_db,
        )
        broadcaster = SessionBroadcaster()
        set_session_broadcaster(broadcaster)

        mock_adapter = MockAdapter()
        executor = LlmExecutor(
            adapters={"openai": mock_adapter},
            task_manager=task_manager,
            session_db=mock_db,
            session_broadcaster=broadcaster,
        )

        app = FastAPI()
        llm_router = create_llm_router(executor=executor)
        app.include_router(llm_router, tags=["llm"])

        return app

    async def test_completion_endpoint_success(self, app_with_llm):
        transport = ASGITransport(app=app_with_llm)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/llm/completions",
                json={
                    "provider": "openai",
                    "model": "gpt-4o-mini",
                    "messages": [{"role": "user", "content": "Hello"}],
                },
                headers={"Authorization": f"Bearer test-bearer-token-for-testing"},
            )

        assert response.status_code == 200
        data = response.json()
        assert data["content"] == "Mock response"
        assert data["provider"] == "openai"
        assert data["model"] == "gpt-4o-mini"
        assert "session_id" in data
        assert data["session_id"].startswith("llm-")

    async def test_completion_endpoint_unconfigured_provider(self, app_with_llm):
        transport = ASGITransport(app=app_with_llm)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/llm/completions",
                json={
                    "provider": "anthropic",
                    "model": "claude-3-5-haiku-latest",
                    "messages": [{"role": "user", "content": "Hello"}],
                },
                headers={"Authorization": f"Bearer test-bearer-token-for-testing"},
            )

        assert response.status_code == 400
        data = response.json()
        assert data["detail"]["error"]["code"] == "PROVIDER_NOT_CONFIGURED"

    async def test_completion_endpoint_no_auth(self, app_with_llm):
        """인증 없이 호출하면 401 (개발 모드에서는 우회)"""
        transport = ASGITransport(app=app_with_llm)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/llm/completions",
                json={
                    "provider": "openai",
                    "model": "gpt-4o-mini",
                    "messages": [{"role": "user", "content": "Hello"}],
                },
                # 개발 모드에서는 AUTH_BEARER_TOKEN이 설정되어 있으므로 401
            )

        # conftest.py에서 AUTH_BEARER_TOKEN이 설정되어 있으므로 401
        assert response.status_code == 401

    async def test_completion_endpoint_invalid_request(self, app_with_llm):
        transport = ASGITransport(app=app_with_llm)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/llm/completions",
                json={
                    "provider": "openai",
                    # model, messages 누락
                },
                headers={"Authorization": f"Bearer test-bearer-token-for-testing"},
            )

        assert response.status_code == 422  # Validation Error
