"""
test_execute_caller_info - POST /execute에서 caller_info 수집·전파 검증.

soul-server /execute 핸들러는 body.caller_info가 있으면 그대로 사용하고,
없으면 FastAPI Request에서 IP/헤더를 조립하여 task_manager.create_task에 전달한다.

검증 기준:
1. body에 caller_info가 없으면 서버가 HTTP Request에서 수집 (source="api").
2. body에 caller_info가 있으면 서버 수집이 덮어쓰지 않는다.
3. 조립된 caller_info는 task_manager.create_task(caller_info=...) 인자로 전달된다.
"""

import os

os.environ.setdefault("ENVIRONMENT", "development")
os.environ.setdefault("WORKSPACE_DIR", "/tmp/soul-server-test-workspace")
os.environ.setdefault("SOULSTREAM_NODE_ID", "test-node")
os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost:5432/test")
os.environ.setdefault("AUTH_BEARER_TOKEN", "test-bearer-token-for-testing")
os.environ.setdefault("AGENTS_CONFIG_FILE", "")

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from soul_server.api.tasks import router as tasks_router
from soul_server.service import resource_manager as rm_module
from soul_server.service.task_models import Task, TaskStatus


TEST_AUTH_TOKEN = "test-bearer-token-for-testing"


def _make_task():
    return Task(
        agent_session_id="sess-exec-1",
        prompt="hello",
        status=TaskStatus.RUNNING,
        client_id="test-client",
        created_at=datetime(2026, 4, 21, 0, 0, 0, tzinfo=timezone.utc),
    )


@pytest_asyncio.fixture
async def app_client():
    """tasks 라우터만 마운트한 테스트 앱.

    task_manager와 soul_engine은 모두 mock으로 교체한다.
    event_generator의 add_listener는 즉시 complete 이벤트를 주입해 스트림을 닫는다.
    """
    task_manager = MagicMock()
    created_task = _make_task()
    task_manager.create_task = AsyncMock(return_value=created_task)
    task_manager.executor.start_execution = AsyncMock()

    async def _fake_add_listener(session_id, queue):
        # complete 이벤트 주입 → SSE 스트림 종료
        await queue.put({"type": "complete", "_event_id": 1})

    task_manager.listener_manager.add_listener = AsyncMock(side_effect=_fake_add_listener)
    task_manager.listener_manager.remove_listener = AsyncMock()

    # can_acquire=True 로 rate limit 통과
    with patch("soul_server.api.tasks.get_task_manager", return_value=task_manager), \
         patch("soul_server.api.tasks.get_soul_engine", return_value=MagicMock()), \
         patch.object(rm_module, "can_acquire", return_value=True):
        app = FastAPI()
        app.include_router(tasks_router)
        transport = ASGITransport(app=app)
        async with AsyncClient(
            transport=transport,
            base_url="http://test",
            headers={"Authorization": f"Bearer {TEST_AUTH_TOKEN}"},
        ) as client:
            yield client, task_manager


class TestExecuteCallerInfo:
    """POST /execute에서 caller_info 수집·전파 검증."""

    async def test_request_metadata_collected_when_body_missing(self, app_client):
        """body에 caller_info가 없으면 HTTP Request에서 조립 (source='api')."""
        client, tm = app_client

        resp = await client.post(
            "/execute",
            json={"prompt": "hello"},
            headers={
                "user-agent": "test-client/1.0",
                "referer": "https://orch.example/",
                "x-forwarded-for": "198.51.100.42",
            },
        )
        # SSE 응답은 200이어야 한다
        assert resp.status_code == 200

        tm.create_task.assert_awaited_once()
        call_kwargs = tm.create_task.call_args.kwargs
        ci = call_kwargs["caller_info"]
        assert ci["source"] == "api"
        assert ci["user_agent"] == "test-client/1.0"
        assert ci["referer"] == "https://orch.example/"
        assert ci["forwarded_for"] == "198.51.100.42"
        assert "ip" in ci

    async def test_body_caller_info_preserved_as_is(self, app_client):
        """body에 caller_info가 있으면 서버 수집이 덮어쓰지 않는다."""
        client, tm = app_client

        supplied = {
            "source": "agent",
            "parent_session_id": "sess-parent",
            "agent_node": "seosoyoung",
            "agent_id": "agent-1",
        }
        resp = await client.post(
            "/execute",
            json={"prompt": "hello", "caller_info": supplied},
            headers={"user-agent": "should-be-ignored"},
        )
        assert resp.status_code == 200

        tm.create_task.assert_awaited_once()
        call_kwargs = tm.create_task.call_args.kwargs
        assert call_kwargs["caller_info"] == supplied

    async def test_caller_info_passed_to_create_task_kwarg(self, app_client):
        """caller_info는 task_manager.create_task의 keyword 인자로 전달된다."""
        client, tm = app_client

        resp = await client.post("/execute", json={"prompt": "hello"})
        assert resp.status_code == 200

        tm.create_task.assert_awaited_once()
        assert "caller_info" in tm.create_task.call_args.kwargs
        assert tm.create_task.call_args.kwargs["caller_info"] is not None
