"""CompactRetryHandler 단위 테스트"""

import pytest
from unittest.mock import AsyncMock

from soul_server.claude.agent_runner import MessageState
from soul_server.claude.compact_retry import (
    MAX_COMPACT_RETRIES,
    CompactRetryHandler,
    CompactRetryState,
    _extract_last_assistant_text,
)


class TestCompactRetryState:
    """CompactRetryState 상태 관리 테스트"""

    def test_snapshot_returns_current_event_count(self):
        state = CompactRetryState()
        assert state.snapshot() == 0

        state.events.append({"trigger": "auto", "message": "compacted"})
        assert state.snapshot() == 1

    def test_did_compact_true_when_new_events(self):
        state = CompactRetryState()
        before = state.snapshot()
        state.events.append({"trigger": "auto", "message": "compacted"})

        assert state.did_compact(before) is True

    def test_did_compact_false_when_no_new_events(self):
        state = CompactRetryState()
        state.events.append({"trigger": "auto", "message": "compacted"})
        before = state.snapshot()

        assert state.did_compact(before) is False

    def test_can_retry_within_limit(self):
        state = CompactRetryState()
        assert state.can_retry() is True

    def test_can_retry_at_limit(self):
        state = CompactRetryState(retry_count=MAX_COMPACT_RETRIES)
        assert state.can_retry() is False

    def test_increment(self):
        state = CompactRetryState()
        state.increment()
        assert state.retry_count == 1
        state.increment()
        assert state.retry_count == 2


class TestExtractLastAssistantText:
    """_extract_last_assistant_text 함수 테스트"""

    def test_returns_last_assistant_text(self):
        messages = [
            {"role": "assistant", "content": "first"},
            {"role": "tool", "content": "tool output"},
            {"role": "assistant", "content": "second"},
        ]
        assert _extract_last_assistant_text(messages) == "second"

    def test_skips_tool_use_messages(self):
        messages = [
            {"role": "assistant", "content": "real text"},
            {"role": "assistant", "content": "[tool_use: Bash] {\"cmd\": \"ls\"}"},
        ]
        assert _extract_last_assistant_text(messages) == "real text"

    def test_returns_empty_when_no_assistant(self):
        messages = [
            {"role": "tool", "content": "output"},
            {"role": "user", "content": "hello"},
        ]
        assert _extract_last_assistant_text(messages) == ""

    def test_returns_empty_for_empty_list(self):
        assert _extract_last_assistant_text([]) == ""

    def test_skips_all_tool_use_returns_empty(self):
        messages = [
            {"role": "assistant", "content": "[tool_use: Read] {}"},
            {"role": "assistant", "content": "[tool_use: Write] {}"},
        ]
        assert _extract_last_assistant_text(messages) == ""


class TestCompactRetryHandlerEvaluate:
    """CompactRetryHandler.evaluate() 판정 로직 테스트"""

    def _make_handler(self, max_retries=MAX_COMPACT_RETRIES):
        return CompactRetryHandler(max_retries=max_retries)

    def _make_msg_state(self, **kwargs):
        return MessageState(**kwargs)

    def test_no_compact_returns_false(self):
        """compact가 발생하지 않으면 False"""
        handler = self._make_handler()
        msg_state = self._make_msg_state()
        before = handler.snapshot()

        result = handler.evaluate(
            msg_state=msg_state,
            before_snapshot=before,
            cli_alive=True,
            pid=1234,
            runner_id="r-1",
        )

        assert result is False
        assert handler.retry_count == 0

    def test_compact_with_result_returns_false(self):
        """compact 발생했지만 이미 결과가 있으면 False"""
        handler = self._make_handler()
        msg_state = self._make_msg_state(result_text="some result")
        before = handler.snapshot()

        # compact 발생 시뮬레이션
        handler.events.append({"trigger": "auto", "message": "compacted"})

        result = handler.evaluate(
            msg_state=msg_state,
            before_snapshot=before,
            cli_alive=True,
            pid=1234,
            runner_id="r-2",
        )

        assert result is False
        assert handler.retry_count == 0

    def test_compact_with_current_text_returns_false(self):
        """compact 발생했지만 current_text가 있으면 has_result=True → False"""
        handler = self._make_handler()
        msg_state = self._make_msg_state(current_text="some text")
        before = handler.snapshot()

        handler.events.append({"trigger": "auto", "message": "compacted"})

        result = handler.evaluate(
            msg_state=msg_state,
            before_snapshot=before,
            cli_alive=True,
            pid=1234,
            runner_id="r-3",
        )

        assert result is False

    def test_compact_no_result_cli_alive_returns_true(self):
        """compact 발생, 결과 없음, CLI 생존 → True (재시도)"""
        handler = self._make_handler()
        msg_state = self._make_msg_state()
        before = handler.snapshot()

        handler.events.append({"trigger": "auto", "message": "compacted"})

        result = handler.evaluate(
            msg_state=msg_state,
            before_snapshot=before,
            cli_alive=True,
            pid=1234,
            runner_id="r-4",
        )

        assert result is True
        assert handler.retry_count == 1

    def test_increments_retry_count_on_each_evaluate(self):
        """evaluate가 True를 반환할 때마다 retry_count 증가"""
        handler = self._make_handler(max_retries=5)
        msg_state = self._make_msg_state()

        for i in range(3):
            before = handler.snapshot()
            handler.events.append({"trigger": "auto", "message": f"compact-{i}"})
            handler.evaluate(
                msg_state=msg_state,
                before_snapshot=before,
                cli_alive=True,
                pid=1234,
                runner_id="r-5",
            )

        assert handler.retry_count == 3

    def test_max_retries_exceeded_returns_false(self):
        """최대 재시도 횟수 초과 시 False

        NOTE: CompactRetryState.can_retry()는 모듈 상수 MAX_COMPACT_RETRIES를 사용한다.
        handler의 max_retries 파라미터는 로그에만 사용되므로, 실제 한계는 MAX_COMPACT_RETRIES.
        """
        handler = self._make_handler()
        msg_state = self._make_msg_state()

        # MAX_COMPACT_RETRIES 횟수만큼 재시도 소진
        for _ in range(MAX_COMPACT_RETRIES):
            before = handler.snapshot()
            handler.events.append({"trigger": "auto", "message": "compacted"})
            handler.evaluate(
                msg_state=msg_state,
                before_snapshot=before,
                cli_alive=True,
                pid=1234,
                runner_id="r-6",
            )

        assert handler.retry_count == MAX_COMPACT_RETRIES

        # 초과 → False
        before = handler.snapshot()
        handler.events.append({"trigger": "auto", "message": "compacted"})
        result = handler.evaluate(
            msg_state=msg_state,
            before_snapshot=before,
            cli_alive=True,
            pid=1234,
            runner_id="r-6",
        )

        assert result is False
        assert handler.retry_count == MAX_COMPACT_RETRIES  # 증가하지 않음

    def test_cli_dead_returns_false_and_restores_fallback(self):
        """CLI 종료 시 False 반환, collected_messages에서 fallback 텍스트 복원"""
        handler = self._make_handler()
        msg_state = self._make_msg_state()
        msg_state.collected_messages = [
            {"role": "assistant", "content": "[tool_use: Bash] {}"},
            {"role": "assistant", "content": "restored text"},
        ]
        before = handler.snapshot()

        handler.events.append({"trigger": "auto", "message": "compacted"})

        result = handler.evaluate(
            msg_state=msg_state,
            before_snapshot=before,
            cli_alive=False,
            pid=9999,
            runner_id="r-7",
        )

        assert result is False
        assert msg_state.current_text == "restored text"

    def test_cli_dead_no_fallback_text(self):
        """CLI 종료, fallback 텍스트 없음 → current_text 변경 없음"""
        handler = self._make_handler()
        msg_state = self._make_msg_state()
        msg_state.collected_messages = []
        before = handler.snapshot()

        handler.events.append({"trigger": "auto", "message": "compacted"})

        result = handler.evaluate(
            msg_state=msg_state,
            before_snapshot=before,
            cli_alive=False,
            pid=9999,
            runner_id="r-8",
        )

        assert result is False
        assert msg_state.current_text == ""


class TestCompactRetryHandlerNotifyEvents:
    """CompactRetryHandler.notify_events() 테스트"""

    @pytest.mark.asyncio
    async def test_notify_calls_on_compact_for_pending(self):
        """미통지 이벤트에 대해 on_compact 콜백 호출"""
        handler = CompactRetryHandler()
        handler.events.append({"trigger": "auto", "message": "msg1"})
        handler.events.append({"trigger": "manual", "message": "msg2"})

        on_compact = AsyncMock()
        await handler.notify_events(on_compact)

        assert on_compact.await_count == 2
        on_compact.assert_any_await("auto", "msg1")
        on_compact.assert_any_await("manual", "msg2")

    @pytest.mark.asyncio
    async def test_notify_updates_notified_count(self):
        """통지 후 notified_count가 갱신된다"""
        handler = CompactRetryHandler()
        handler.events.append({"trigger": "auto", "message": "msg1"})

        on_compact = AsyncMock()
        await handler.notify_events(on_compact)

        assert handler.state.notified_count == 1

        # 새 이벤트 추가 후 다시 통지
        handler.events.append({"trigger": "manual", "message": "msg2"})
        await handler.notify_events(on_compact)

        assert handler.state.notified_count == 2
        # 첫 호출 1회 + 두 번째 호출 1회 = 총 2회
        assert on_compact.await_count == 2

    @pytest.mark.asyncio
    async def test_notify_skips_when_no_callback(self):
        """on_compact가 None이면 아무 것도 하지 않는다"""
        handler = CompactRetryHandler()
        handler.events.append({"trigger": "auto", "message": "msg1"})

        # 예외 없이 완료
        await handler.notify_events(None)

    @pytest.mark.asyncio
    async def test_notify_skips_when_no_pending(self):
        """미통지 이벤트가 없으면 콜백 호출하지 않는다"""
        handler = CompactRetryHandler()

        on_compact = AsyncMock()
        await handler.notify_events(on_compact)

        on_compact.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_notify_handles_callback_error(self):
        """콜백 오류가 발생해도 나머지 이벤트를 계속 처리한다"""
        handler = CompactRetryHandler()
        handler.events.append({"trigger": "auto", "message": "msg1"})
        handler.events.append({"trigger": "manual", "message": "msg2"})

        call_count = 0

        async def failing_callback(trigger, message):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise RuntimeError("callback failed")

        await handler.notify_events(failing_callback)

        # 두 번 모두 시도됨 (첫 번째 실패, 두 번째 성공)
        assert call_count == 2
        # notified_count는 전체 이벤트 수로 갱신
        assert handler.state.notified_count == 2
