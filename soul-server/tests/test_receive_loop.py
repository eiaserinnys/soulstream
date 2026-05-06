"""ReceiveLoop 단위 테스트"""

import asyncio
from collections import deque
from dataclasses import dataclass
from unittest.mock import AsyncMock, MagicMock

import pytest

from soul_server.claude.receive_loop import (
    ReceiveLoop,
    INTERVENTION_POLL_INTERVAL,
    MAX_INTERVENTION_DRAIN,
    PROMPT_SUGGESTION_DRAIN_TIMEOUT,
)
from soul_server.claude.compact_retry import CompactRetryHandler
from soul_server.claude.agent_runner import MessageState
from soul_server.engine.types import EngineEvent


# --- Mock helpers ---


@dataclass
class MockSystemMessage:
    session_id: str = None


@dataclass
class MockTextBlock:
    text: str


@dataclass
class MockAssistantMessage:
    content: list = None


@dataclass
class MockResultMessage:
    result: str = ""
    session_id: str = None
    is_error: bool = False


def _make_mock_client(*messages):
    """mock_receive async generator를 설정한 mock client를 생성하는 헬퍼"""
    mock_client = AsyncMock()

    async def mock_receive():
        for msg in messages:
            yield msg

    mock_client.receive_messages = mock_receive
    return mock_client


def _make_receive_loop(pending_events=None):
    """테스트용 ReceiveLoop 인스턴스 생성"""
    events = pending_events if pending_events is not None else deque()
    return ReceiveLoop(
        runner_id="test-runner",
        pending_events=events,
        on_client_session_update=lambda sid: None,
    )


# --- Tests ---


class TestReceiveLoopRun:
    """ReceiveLoop.run() 통합 동작 테스트"""

    @pytest.mark.asyncio
    async def test_run_basic_message_flow(self):
        """SystemMessage + ResultMessage 순서 수신 확인"""
        from unittest.mock import patch

        loop = _make_receive_loop()
        client = _make_mock_client(
            MockSystemMessage(session_id="sess-1"),
            MockResultMessage(result="완료", session_id="sess-1"),
        )
        msg_state = MessageState()
        compact_handler = CompactRetryHandler()

        with patch(
            "soul_server.claude.message_processor.SystemMessage", MockSystemMessage
        ):
            with patch(
                "soul_server.claude.message_processor.ResultMessage", MockResultMessage
                ), patch(
                    "soul_server.claude.receive_loop.ResultMessage", MockResultMessage
            ):
                await loop.run(client, compact_handler, msg_state)

        assert msg_state.session_id == "sess-1"
        assert msg_state.result_text == "완료"

    @pytest.mark.asyncio
    async def test_run_drain_after_result(self):
        """ResultMessage 수신 후 인터벤션 드레인이 호출됨"""
        from unittest.mock import patch

        loop = _make_receive_loop()
        query_calls = []

        mock_client = _make_mock_client(
            MockSystemMessage(session_id="drain-test"),
            MockResultMessage(result="완료", session_id="drain-test"),
        )
        original_query = mock_client.query

        async def tracking_query(text):
            query_calls.append(text)
            await original_query(text)

        mock_client.query = tracking_query

        pending = ["intv-1", "intv-2"]

        async def on_intervention():
            if pending:
                return pending.pop(0)
            return None

        msg_state = MessageState()
        compact_handler = CompactRetryHandler()

        with patch(
            "soul_server.claude.message_processor.SystemMessage", MockSystemMessage
        ):
            with patch(
                "soul_server.claude.message_processor.ResultMessage",
                MockResultMessage,
            ):
                await loop.run(
                    mock_client,
                    compact_handler,
                    msg_state,
                    on_intervention=on_intervention,
                )

        assert "intv-1" in query_calls
        assert "intv-2" in query_calls

    @pytest.mark.asyncio
    async def test_msg_task_cancelled_on_exit(self):
        """비정상 종료 시 대기 중인 msg_task가 정리됨"""
        loop = _make_receive_loop()

        # 무한 대기하는 client — CancelledError로 강제 종료
        mock_client = AsyncMock()
        never_ending = asyncio.Future()

        async def stuck_receive():
            yield await never_ending

        mock_client.receive_messages = stuck_receive
        msg_state = MessageState()
        compact_handler = CompactRetryHandler()

        task = asyncio.create_task(loop.run(mock_client, compact_handler, msg_state))
        await asyncio.sleep(0.05)
        task.cancel()

        with pytest.raises(asyncio.CancelledError):
            await task

    @pytest.mark.asyncio
    async def test_intervention_polling_parallel_with_receive(self):
        """msg_task 대기 중 인터벤션 폴링이 병렬로 실행됨"""
        from unittest.mock import patch

        loop = _make_receive_loop()
        poll_count = 0

        # 메시지 수신에 지연이 있는 client
        mock_client = AsyncMock()
        messages_sent = False

        async def slow_receive():
            nonlocal messages_sent
            await asyncio.sleep(0.3)  # 폴링 인터벌보다 긴 지연
            yield MockSystemMessage(session_id="poll-test")
            yield MockResultMessage(result="done", session_id="poll-test")

        mock_client.receive_messages = slow_receive

        async def on_intervention():
            nonlocal poll_count
            poll_count += 1
            return None  # 주입할 인터벤션 없음

        msg_state = MessageState()
        compact_handler = CompactRetryHandler()

        with patch(
            "soul_server.claude.receive_loop.INTERVENTION_POLL_INTERVAL", 0.05
        ):
            with patch(
                "soul_server.claude.message_processor.SystemMessage",
                MockSystemMessage,
            ):
                with patch(
                    "soul_server.claude.message_processor.ResultMessage",
                    MockResultMessage,
                ):
                    await loop.run(
                        mock_client,
                        compact_handler,
                        msg_state,
                        on_intervention=on_intervention,
                    )

        # 300ms 동안 50ms 인터벌로 최소 2번 이상 ��링 발생해야 함
        assert poll_count >= 2


class TestPollIntervention:
    """_poll_intervention 단위 테스트"""

    @pytest.mark.asyncio
    async def test_poll_intervention_injects_message(self):
        """on_intervention이 텍스트를 반환하면 client.query 호출"""
        loop = _make_receive_loop()
        client = AsyncMock()

        async def on_intervention():
            return "사용자 메시지"

        result = await loop._poll_intervention(client, on_intervention)

        assert result is True
        client.query.assert_called_once_with("사용자 메시지")

    @pytest.mark.asyncio
    async def test_poll_intervention_no_message(self):
        """on_intervention이 None을 반환하면 query 미호출"""
        loop = _make_receive_loop()
        client = AsyncMock()

        async def on_intervention():
            return None

        result = await loop._poll_intervention(client, on_intervention)

        assert result is False
        client.query.assert_not_called()

    @pytest.mark.asyncio
    async def test_poll_intervention_error_ignored(self):
        """콜백 예외 시 False 반환, 루프 중단 없음"""
        loop = _make_receive_loop()
        client = AsyncMock()

        async def on_intervention():
            raise RuntimeError("콜백 오류")

        result = await loop._poll_intervention(client, on_intervention)

        assert result is False
        client.query.assert_not_called()


class TestDrainInterventions:
    """_drain_interventions 단위 테스트"""

    @pytest.mark.asyncio
    async def test_drain_interventions_consumes_all(self):
        """큐의 모든 인터벤션 소비"""
        loop = _make_receive_loop()
        client = AsyncMock()
        messages = ["msg1", "msg2", "msg3"]

        async def on_intervention():
            if messages:
                return messages.pop(0)
            return None

        count = await loop._drain_interventions(client, on_intervention)

        assert count == 3
        assert client.query.call_count == 3

    @pytest.mark.asyncio
    async def test_drain_interventions_max_limit(self):
        """MAX_INTERVENTION_DRAIN 상한 도달 시 중단"""
        from unittest.mock import patch

        loop = _make_receive_loop()
        client = AsyncMock()

        async def on_intervention():
            return "계속 전달"

        with patch("soul_server.claude.receive_loop.MAX_INTERVENTION_DRAIN", 5):
            count = await loop._drain_interventions(client, on_intervention)

        assert count == 5

    @pytest.mark.asyncio
    async def test_drain_interventions_error_breaks(self):
        """client.query 예외 시 드레인 중단"""
        loop = _make_receive_loop()
        client = AsyncMock()
        client.query.side_effect = RuntimeError("세션 종료")
        call_count = 0

        async def on_intervention():
            nonlocal call_count
            call_count += 1
            return "msg" if call_count <= 3 else None

        count = await loop._drain_interventions(client, on_intervention)

        # 첫 query에서 예�� → count 0, break
        assert count == 0


class TestNotifyPendingSubagentEvents:
    """_notify_pending_subagent_events 단위 테스트"""

    @pytest.mark.asyncio
    async def test_notify_pending_subagent_events(self):
        """pending deque의 이벤트가 on_event 콜백으로 전달"""
        events_deque = deque()
        event1 = EngineEvent()
        event2 = EngineEvent()
        events_deque.append(event1)
        events_deque.append(event2)

        loop = _make_receive_loop(pending_events=events_deque)
        received = []

        async def on_event(event):
            received.append(event)

        await loop._notify_pending_subagent_events(on_event)

        assert received == [event1, event2]
        assert len(events_deque) == 0  # 큐 비워짐

    @pytest.mark.asyncio
    async def test_notify_no_callback_noop(self):
        """on_event=None이면 아무 동작 없음"""
        events_deque = deque()
        events_deque.append(EngineEvent())

        loop = _make_receive_loop(pending_events=events_deque)

        await loop._notify_pending_subagent_events(None)

        # 이벤트는 소비되지 않음
        assert len(events_deque) == 1

    @pytest.mark.asyncio
    async def test_notify_callback_error_continues(self):
        """콜백 예외 시 나머지 이벤트도 처리"""
        events_deque = deque()
        event1 = EngineEvent(agent_id="evt1")
        event2 = EngineEvent(agent_id="evt2")
        events_deque.append(event1)
        events_deque.append(event2)

        loop = _make_receive_loop(pending_events=events_deque)
        received = []

        async def on_event(event):
            if event.agent_id == "evt1":
                raise RuntimeError("첫 이벤트 처리 실패")
            received.append(event)

        await loop._notify_pending_subagent_events(on_event)

        # 예외에도 불구하고 두 번째 이벤트 처리됨
        assert received == [event2]
        assert len(events_deque) == 0


# ─────────────────────────────────────────────────────────────────────────────
# prompt_suggestion drain 테스트 (260506.05)
#
# TS SDK 0.2.x 명시: prompt_suggestion arrives after the result message.
# receive_response()가 result에서 즉시 return하던 한계를 우회하기 위해
# receive_messages()로 stream을 유지 + ResultMessage 후 짧은 추가 drain.
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class _MockPromptSuggestionMessage:
    """sdk_patches.PromptSuggestionMessage를 흉내낸 더미 — message_processor가
    isinstance 체크를 통과하도록 같은 클래스를 patch로 주입한다."""
    suggestion: str = ""
    uuid: str = None
    session_id: str = None


class TestPromptSuggestionDrain:
    """ResultMessage 수신 후 prompt_suggestion drain phase 검증"""

    @pytest.mark.asyncio
    async def test_drain_receives_prompt_suggestion(self):
        """ResultMessage 다음 stream에서 PromptSuggestionMessage가 도착하면 처리한다"""
        from unittest.mock import patch

        loop = _make_receive_loop()
        sugg = _MockPromptSuggestionMessage(suggestion="다음 단계를 시도해보세요")
        client = _make_mock_client(
            MockSystemMessage(session_id="sess-A"),
            MockResultMessage(result="ok", session_id="sess-A"),
            sugg,
        )

        msg_state = MessageState()
        compact_handler = CompactRetryHandler()
        events_received = []

        async def on_event(ev):
            events_received.append(ev)

        with patch(
            "soul_server.claude.message_processor.SystemMessage", MockSystemMessage
        ), patch(
            "soul_server.claude.message_processor.ResultMessage", MockResultMessage
        ), patch(
            "soul_server.claude.sdk_patches.PromptSuggestionMessage",
            _MockPromptSuggestionMessage,
        ):
            await loop.run(
                client, compact_handler, msg_state, on_event=on_event,
            )

        # prompt_suggestion이 EngineEvent로 변환되어 on_event에 도착
        from soul_server.engine.types import PromptSuggestionEngineEvent
        suggestion_events = [
            e for e in events_received
            if isinstance(e, PromptSuggestionEngineEvent)
        ]
        assert len(suggestion_events) == 1
        assert suggestion_events[0].text == "다음 단계를 시도해보세요"

    @pytest.mark.asyncio
    async def test_drain_timeout_when_no_prompt_suggestion(self):
        """ResultMessage 후 stream이 무한 대기하면 drain timeout으로 정상 종료"""
        from unittest.mock import patch

        loop = _make_receive_loop()
        mock_client = AsyncMock()

        # Future 기반 영원-대기 — cancel 시 GeneratorExit 즉시 처리되어
        # asyncio.sleep(60) 같은 timer 큐에 비해 cleanup이 깔끔하다.
        blocker = asyncio.Future()

        async def receive_with_long_wait():
            yield MockSystemMessage(session_id="sess-T")
            yield MockResultMessage(result="ok", session_id="sess-T")
            try:
                await blocker  # cancel될 때까지 대기
            except asyncio.CancelledError:
                return

        mock_client.receive_messages = receive_with_long_wait
        msg_state = MessageState()
        compact_handler = CompactRetryHandler()

        # timeout을 짧게 설정하여 테스트 시간 단축
        with patch(
            "soul_server.claude.receive_loop.PROMPT_SUGGESTION_DRAIN_TIMEOUT", 0.1
        ), patch(
            "soul_server.claude.message_processor.SystemMessage", MockSystemMessage
        ), patch(
            "soul_server.claude.message_processor.ResultMessage", MockResultMessage
            ), patch(
                "soul_server.claude.receive_loop.ResultMessage", MockResultMessage
        ):
            # 0.1s drain + cleanup — 2초 안에 끝나야 함
            await asyncio.wait_for(
                loop.run(mock_client, compact_handler, msg_state),
                timeout=2.0,
            )

        # ResultMessage까지 정상 처리됨
        assert msg_state.result_text == "ok"

    @pytest.mark.asyncio
    async def test_drain_stop_async_iteration(self):
        """ResultMessage 후 stream이 즉시 종료되어도 정상 return"""
        from unittest.mock import patch

        loop = _make_receive_loop()
        client = _make_mock_client(
            MockSystemMessage(session_id="sess-S"),
            MockResultMessage(result="ok", session_id="sess-S"),
            # 그 외 메시지 없음 → StopAsyncIteration
        )
        msg_state = MessageState()
        compact_handler = CompactRetryHandler()

        with patch(
            "soul_server.claude.message_processor.SystemMessage", MockSystemMessage
        ), patch(
            "soul_server.claude.message_processor.ResultMessage", MockResultMessage
            ), patch(
                "soul_server.claude.receive_loop.ResultMessage", MockResultMessage
        ):
            await asyncio.wait_for(
                loop.run(client, compact_handler, msg_state),
                timeout=1.0,
            )

        assert msg_state.result_text == "ok"

    @pytest.mark.asyncio
    async def test_drain_ignores_non_suggestion_message(self):
        """drain phase는 PromptSuggestion 전용 — 다른 타입은 logger.warning 후 무시"""
        from unittest.mock import patch

        loop = _make_receive_loop()
        # ResultMessage 후 새 SystemMessage (init) — compact retry 시뮬.
        # drain phase는 PromptSuggestion 전용이라 이 메시지는 무시되고,
        # 외부 compact retry 루프가 has_result=False면 재진입하여 후속 메시지를 받는다.
        client = _make_mock_client(
            MockSystemMessage(session_id="sess-1"),
            MockResultMessage(result="ok", session_id="sess-1"),
            MockSystemMessage(session_id="sess-2"),  # drain phase에서 받지만 무시됨
        )
        msg_state = MessageState()
        compact_handler = CompactRetryHandler()

        with patch(
            "soul_server.claude.message_processor.SystemMessage", MockSystemMessage
        ), patch(
            "soul_server.claude.message_processor.ResultMessage", MockResultMessage
            ), patch(
                "soul_server.claude.receive_loop.ResultMessage", MockResultMessage
        ):
            await loop.run(client, compact_handler, msg_state)

        # drain phase의 SystemMessage(sess-2)는 무시되고 첫 SystemMessage(sess-1)이 정본
        assert msg_state.session_id == "sess-1"
        assert msg_state.result_text == "ok"

    @pytest.mark.asyncio
    async def test_drain_constant_exposed(self):
        """PROMPT_SUGGESTION_DRAIN_TIMEOUT 상수가 export되어 있어야 한다 (운영 튜닝 가능)"""
        # 너무 짧으면 LLM 응답을 못 받고, 너무 길면 turn 응답 지연.
        # 기본값을 0.5s 이상 5s 이하로 합리적 범위 검증 (회귀 가드).
        assert 0.5 <= PROMPT_SUGGESTION_DRAIN_TIMEOUT <= 5.0
