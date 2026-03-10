"""
LLM Executor - LLM 실행 서비스

LLM 프록시 요청을 처리하고, 세션 추적 및 이벤트 저장을 수행합니다.
"""

import logging
import secrets
import time

from soul_server.models.llm import LlmCompletionRequest, LlmCompletionResponse
from soul_server.service.task_models import (
    Task,
    TaskStatus,
    utc_now,
)
from soul_server.service.task_manager import TaskManager
from soul_server.service.event_store import EventStore
from soul_server.service.session_broadcaster import SessionBroadcaster
from soul_server.llm.adapters import LlmAdapter

logger = logging.getLogger(__name__)


def _generate_llm_session_id() -> str:
    """LLM 세션 ID 생성"""
    timestamp = utc_now().strftime("%Y%m%d%H%M%S")
    random_part = secrets.token_hex(4)
    return f"llm-{timestamp}-{random_part}"


class LlmExecutor:
    """LLM 실행 서비스

    외부 서비스의 LLM 프록시 요청을 처리하고,
    호출 이력을 세션으로 추적합니다.

    Args:
        adapters: 프로바이더별 LLM 어댑터 딕셔너리
        task_manager: 세션 관리자
        event_store: 이벤트 저장소
        session_broadcaster: 세션 변경 브로드캐스터
    """

    def __init__(
        self,
        adapters: dict[str, LlmAdapter],
        task_manager: TaskManager,
        event_store: EventStore,
        session_broadcaster: SessionBroadcaster,
    ) -> None:
        self._adapters = adapters
        self._task_manager = task_manager
        self._event_store = event_store
        self._session_broadcaster = session_broadcaster

    async def execute(self, request: LlmCompletionRequest) -> LlmCompletionResponse:
        """LLM 완성 요청 실행

        1. 세션 생성 및 등록
        2. 요청 이벤트 기록
        3. LLM 호출
        4. 응답 이벤트 기록
        5. 세션 완료 처리

        Args:
            request: LLM 완성 요청

        Returns:
            LLM 완성 응답

        Raises:
            ValueError: 미설정 프로바이더 호출
        """
        adapter = self._adapters.get(request.provider)
        if adapter is None:
            raise ValueError(
                f"Provider '{request.provider}' is not configured. "
                f"Set LLM_{request.provider.upper()}_API_KEY environment variable."
            )

        agent_session_id = _generate_llm_session_id()

        # Task 생성 및 등록 (TaskManager 공개 API 사용)
        task = Task(
            agent_session_id=agent_session_id,
            prompt=request.messages[-1].content if request.messages else "",
            status=TaskStatus.RUNNING,
            client_id=request.client_id,
            session_type="llm",
            llm_provider=request.provider,
            llm_model=request.model,
        )
        await self._task_manager.register_external_task(task)

        # 세션 생성 브로드캐스트 (부가 기능)
        try:
            await self._session_broadcaster.emit_session_created(task)
        except Exception:
            logger.warning(
                f"Failed to broadcast session created for {agent_session_id}",
                exc_info=True,
            )

        # 요청 이벤트 기록
        request_event = {
            "type": "user_message",
            "timestamp": time.time(),
            "messages": [m.model_dump() for m in request.messages],
            "provider": request.provider,
            "model": request.model,
            "max_tokens": request.max_tokens,
            "client_id": request.client_id,
        }
        self._event_store.append(agent_session_id, request_event)

        try:
            # LLM 호출
            result = await adapter.complete(
                model=request.model,
                messages=request.messages,
                max_tokens=request.max_tokens,
                temperature=request.temperature,
            )

            usage = {
                "input_tokens": result.input_tokens,
                "output_tokens": result.output_tokens,
            }

            # 응답 이벤트 기록
            response_event = {
                "type": "assistant_message",
                "timestamp": time.time(),
                "content": result.content,
                "usage": usage,
                "model": request.model,
                "provider": request.provider,
            }
            self._event_store.append(agent_session_id, response_event)

            # Task 완료 처리 (TaskManager 공개 API 사용)
            await self._task_manager.finalize_task(
                agent_session_id,
                result=result.content,
                llm_usage=usage,
            )

            logger.info(
                f"LLM completion: session={agent_session_id} "
                f"provider={request.provider} model={request.model} "
                f"tokens={result.input_tokens}+{result.output_tokens}"
            )

            return LlmCompletionResponse(
                session_id=agent_session_id,
                content=result.content,
                usage=usage,
                model=request.model,
                provider=request.provider,
            )

        except Exception as e:
            # 에러 이벤트 기록
            error_event = {
                "type": "error",
                "timestamp": time.time(),
                "message": str(e),
                "provider": request.provider,
                "model": request.model,
            }
            self._event_store.append(agent_session_id, error_event)

            # Task 에러 처리 (TaskManager 공개 API 사용)
            await self._task_manager.finalize_task(
                agent_session_id,
                error=str(e),
            )

            logger.error(
                f"LLM completion failed: session={agent_session_id} "
                f"provider={request.provider} model={request.model} "
                f"error={e}"
            )
            raise
