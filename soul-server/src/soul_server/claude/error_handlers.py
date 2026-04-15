"""ClaudeRunner 에러 핸들링 함수 모듈

agent_runner.py에서 추출한 에러 핸들러.
각 함수는 특정 예외 타입을 EngineResult로 변환한다.
"""

import logging
from datetime import datetime, timezone
from typing import Optional

from soul_server.claude.diagnostics import (
    DebugSendFn,
    build_session_dump,
    classify_process_error,
)
from soul_server.claude.sdk_compat import ParseAction, classify_parse_error
from soul_server.engine.types import EngineResult

try:
    from claude_agent_sdk._errors import MessageParseError
    from claude_agent_sdk import ProcessError
except ImportError:
    class MessageParseError(Exception):
        pass
    class ProcessError(Exception):
        pass

logger = logging.getLogger(__name__)


def finalize_result(msg_state) -> EngineResult:
    """정상 완료 시 결과 생성

    Args:
        msg_state: MessageState 인스턴스

    Returns:
        EngineResult: 엔진 실행 결과
    """
    output = msg_state.result_text or msg_state.current_text
    return EngineResult(
        success=not msg_state.is_error,
        output=output,
        session_id=msg_state.session_id,
        collected_messages=msg_state.collected_messages,
        is_error=msg_state.is_error,
        usage=msg_state.usage,
    )


def handle_file_not_found(e: FileNotFoundError) -> EngineResult:
    """FileNotFoundError → EngineResult"""
    logger.error(f"Claude Code CLI를 찾을 수 없습니다: {e}")
    return EngineResult(
        success=False,
        output="",
        error="Claude Code CLI를 찾을 수 없습니다. claude 명령어가 PATH에 있는지 확인하세요.",
    )


def handle_process_error(
    e: "ProcessError",
    ctx,
    *,
    pid: Optional[int] = None,
    debug_fn: Optional[DebugSendFn] = None,
    active_clients_count: int = 0,
) -> EngineResult:
    """ProcessError → EngineResult

    Args:
        e: ProcessError 예외
        ctx: ExecutionContext
        pid: 프로세스 ID
        debug_fn: 디버그 메시지 전송 함수
        active_clients_count: 활성 클라이언트 수
    """
    msg_state = ctx.msg_state
    friendly_msg = classify_process_error(e)
    logger.error(
        f"Claude Code CLI 프로세스 오류: exit_code={e.exit_code}, "
        f"stderr={e.stderr}, friendly={friendly_msg}"
    )
    _dur = (datetime.now(timezone.utc) - ctx.session_start).total_seconds()
    dump = build_session_dump(
        reason="ProcessError",
        pid=pid,
        duration_sec=_dur,
        message_count=msg_state.msg_count,
        last_tool="",
        current_text_len=len(msg_state.current_text),
        result_text_len=len(msg_state.result_text),
        session_id=msg_state.session_id,
        exit_code=e.exit_code,
        error_detail=str(e.stderr or e),
        active_clients_count=active_clients_count,
        runner_id=ctx.runner_id,
    )
    if debug_fn:
        try:
            debug_fn(dump)
        except Exception as debug_err:
            logger.warning(f"디버그 메시지 전송 실패: {debug_err}")

    return EngineResult(
        success=False,
        output=msg_state.current_text,
        session_id=msg_state.session_id,
        error=friendly_msg,
    )


def handle_parse_error(
    e: "MessageParseError",
    msg_state,
) -> EngineResult:
    """MessageParseError → EngineResult"""
    action, msg_type = classify_parse_error(e.data, log_fn=logger)

    if msg_type == "rate_limit_event":
        logger.warning(f"rate_limit_event (외부 catch): {e}")
        return EngineResult(
            success=False,
            output=msg_state.current_text,
            session_id=msg_state.session_id,
            error="사용량 제한에 도달했습니다. 잠시 후 다시 시도해주세요.",
        )

    if action is ParseAction.CONTINUE:
        logger.warning(f"Unknown message type escaped loop: {msg_type}")
        return EngineResult(
            success=False,
            output=msg_state.current_text,
            session_id=msg_state.session_id,
            error=f"알 수 없는 메시지 타입: {msg_type}",
        )

    logger.exception(f"SDK 메시지 파싱 오류: {e}")
    return EngineResult(
        success=False,
        output=msg_state.current_text,
        session_id=msg_state.session_id,
        error="Claude 응답 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
    )


def handle_unknown_error(
    e: Exception,
    msg_state,
) -> EngineResult:
    """알 수 없는 예외 → EngineResult"""
    logger.exception(f"Claude Code SDK 실행 오류: {e}")
    return EngineResult(
        success=False,
        output=msg_state.current_text,
        session_id=msg_state.session_id,
        error=str(e),
    )
