"""error_handlers 모듈 단위 테스트

agent_runner.py에서 추출된 에러 핸들러 함수들의 독립 동작을 검증한다.
"""

import pytest
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional
from unittest.mock import MagicMock

from soul_server.claude.error_handlers import (
    finalize_result,
    handle_file_not_found,
    handle_parse_error,
    handle_process_error,
    handle_unknown_error,
)
from soul_server.engine.types import EngineResult


# --- Lightweight fakes (agent_runner 의존 없이 테스트) ---


@dataclass
class FakeMessageState:
    session_id: Optional[str] = "sess-1"
    current_text: str = "partial"
    result_text: str = ""
    is_error: bool = False
    usage: Optional[dict] = None
    collected_messages: list = field(default_factory=list)
    msg_count: int = 0


@dataclass
class FakeExecutionContext:
    runner_id: str = "runner-1"
    session_start: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    msg_state: FakeMessageState = field(default_factory=FakeMessageState)


class FakeProcessError(Exception):
    def __init__(self, exit_code=1, stderr="boom"):
        self.exit_code = exit_code
        self.stderr = stderr
        super().__init__(stderr)


class FakeMessageParseError(Exception):
    def __init__(self, data=None):
        self.data = data or {}
        super().__init__(str(data))


# --- Tests ---


class TestFinalizeResult:
    def test_success_with_result_text(self):
        ms = FakeMessageState(result_text="done", current_text="partial")
        result = finalize_result(ms)
        assert result.success is True
        assert result.output == "done"  # result_text 우선
        assert result.session_id == "sess-1"

    def test_success_falls_back_to_current_text(self):
        ms = FakeMessageState(result_text="", current_text="streaming")
        result = finalize_result(ms)
        assert result.output == "streaming"

    def test_error_flag_propagated(self):
        ms = FakeMessageState(is_error=True, current_text="err")
        result = finalize_result(ms)
        assert result.success is False
        assert result.is_error is True

    def test_usage_and_messages_propagated(self):
        ms = FakeMessageState(
            usage={"input_tokens": 10},
            collected_messages=[{"role": "assistant"}],
        )
        result = finalize_result(ms)
        assert result.usage == {"input_tokens": 10}
        assert len(result.collected_messages) == 1


class TestHandleFileNotFound:
    def test_returns_engine_result_with_cli_error(self):
        result = handle_file_not_found(FileNotFoundError("no such file"))
        assert result.success is False
        assert "CLI" in result.error
        assert result.output == ""


class TestHandleProcessError:
    def test_returns_failure_with_friendly_message(self):
        ctx = FakeExecutionContext()
        e = FakeProcessError(exit_code=1, stderr="something went wrong")
        result = handle_process_error(e, ctx, pid=12345, active_clients_count=2)
        assert result.success is False
        assert result.session_id == "sess-1"

    def test_debug_fn_called_when_provided(self):
        ctx = FakeExecutionContext()
        e = FakeProcessError()
        debug_fn = MagicMock()
        handle_process_error(e, ctx, debug_fn=debug_fn)
        debug_fn.assert_called_once()

    def test_debug_fn_exception_suppressed(self):
        ctx = FakeExecutionContext()
        e = FakeProcessError()
        debug_fn = MagicMock(side_effect=RuntimeError("send failed"))
        # Should not raise
        result = handle_process_error(e, ctx, debug_fn=debug_fn)
        assert result.success is False


class TestHandleParseError:
    def test_rate_limit_event(self):
        e = FakeMessageParseError(data={"type": "rate_limit_event"})
        ms = FakeMessageState()
        result = handle_parse_error(e, ms)
        assert result.success is False
        assert "사용량 제한" in result.error

    def test_unknown_message_type(self):
        e = FakeMessageParseError(data={"type": "unknown_exotic_type"})
        ms = FakeMessageState()
        result = handle_parse_error(e, ms)
        assert result.success is False


class TestHandleUnknownError:
    def test_wraps_exception_message(self):
        ms = FakeMessageState(current_text="partial output")
        e = ValueError("unexpected")
        result = handle_unknown_error(e, ms)
        assert result.success is False
        assert "unexpected" in result.error
        assert result.output == "partial output"
