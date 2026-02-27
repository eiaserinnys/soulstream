"""세션 진단 및 에러 분류 로직

agent_runner.py에서 분리된 진단 전용 모듈.
ProcessError 분류, 세션 덤프 생성, stderr 캡처 등을 담당합니다.
"""

import logging
import os
from collections import deque
from pathlib import Path
from typing import Callable, Optional

try:
    from claude_code_sdk._errors import ProcessError
except ImportError:
    class ProcessError(Exception):
        """더미 ProcessError"""
        exit_code: int = 1
        stderr: str = ""

logger = logging.getLogger(__name__)


def read_stderr_tail(n_lines: int = 30, *, runner_id: Optional[str] = None) -> str:
    """세션별 cli_stderr 로그의 마지막 N줄 읽기

    세션별 파일(cli_stderr_{runner_id}.log)을 우선 시도하고,
    없으면 공유 파일(cli_stderr.log)로 폴백합니다.

    Args:
        n_lines: 읽을 줄 수
        runner_id: 러너 식별자 (None이면 "default" 사용)
    """
    try:
        runtime_dir = Path(__file__).resolve().parents[4]
        logs_dir = runtime_dir / "logs"

        # 세션별 파일 경로 결정
        suffix = runner_id or "default"
        session_path = logs_dir / f"cli_stderr_{suffix}.log"

        # 세션별 파일 우선, 없으면 공유 파일로 폴백
        if session_path.exists():
            stderr_path = session_path
        else:
            stderr_path = logs_dir / "cli_stderr.log"
            if not stderr_path.exists():
                return "(cli_stderr.log not found)"

        with open(stderr_path, "r", encoding="utf-8", errors="replace") as f:
            tail = list(deque(f, maxlen=n_lines))
        return "".join(tail).strip()
    except Exception as e:
        return f"(stderr 읽기 실패: {e})"


def build_session_dump(
    *,
    reason: str,
    pid: Optional[int],
    duration_sec: float,
    message_count: int,
    last_tool: str,
    current_text_len: int,
    result_text_len: int,
    session_id: Optional[str],
    exit_code: Optional[int] = None,
    error_detail: str = "",
    active_clients_count: int = 0,
    runner_id: Optional[str] = None,
) -> str:
    """세션 종료 진단 덤프 메시지 생성

    Args:
        runner_id: 러너 식별자 (세션별 stderr 파일 식별용)
    """
    parts = [
        f"Session Dump — {reason}",
        f"  PID: {pid}",
        f"  Duration: {duration_sec:.1f}s",
        f"  Messages received: {message_count}",
        f"  Last tool: {last_tool or '(none)'}",
        f"  Output: current_text={current_text_len} chars, result_text={result_text_len} chars",
        f"  Session ID: {session_id or '(none)'}",
        f"  Active clients: {active_clients_count}",
    ]
    if exit_code is not None:
        parts.append(f"  Exit code: {exit_code}")
    if error_detail:
        parts.append(f"  Error: {error_detail[:300]}")

    stderr_tail = read_stderr_tail(20, runner_id=runner_id)
    if stderr_tail:
        if len(stderr_tail) > 1500:
            stderr_tail = stderr_tail[-1500:]
        parts.append(f"  stderr tail:\n{stderr_tail}")

    return "\n".join(parts)


def classify_process_error(e: ProcessError) -> str:
    """ProcessError를 사용자 친화적 메시지로 변환.

    Claude Code CLI는 다양한 이유로 exit code 1을 반환하지만,
    SDK가 stderr를 캡처하지 않아 원인 구분이 어렵습니다.
    exit_code와 stderr 패턴을 기반으로 최대한 분류합니다.
    """
    error_str = str(e).lower()
    stderr = (e.stderr or "").lower()
    combined = f"{error_str} {stderr}"

    # 사용량 제한 관련 패턴
    if any(kw in combined for kw in ["usage limit", "rate limit", "quota", "too many requests", "429"]):
        return "사용량 제한에 도달했습니다. 잠시 후 다시 시도해주세요."

    # 인증 관련 패턴
    if any(kw in combined for kw in ["unauthorized", "401", "auth", "token", "credentials", "forbidden", "403"]):
        return "인증에 실패했습니다. 관리자에게 문의해주세요."

    # 네트워크 관련 패턴
    if any(kw in combined for kw in ["network", "connection", "timeout", "econnrefused", "dns"]):
        return "네트워크 연결에 문제가 있습니다. 잠시 후 다시 시도해주세요."

    # exit code 1인데 구체적인 원인을 알 수 없는 경우
    if e.exit_code == 1:
        return (
            "Claude Code가 비정상 종료했습니다. "
            "사용량 제한이나 일시적 오류일 수 있으니 잠시 후 다시 시도해주세요."
        )

    # 기타
    return f"Claude Code 실행 중 오류가 발생했습니다 (exit code: {e.exit_code})"


_RATE_LIMIT_TYPE_KO = {
    "seven_day": "주간",
    "five_hour": "5시간",
}


def format_rate_limit_warning(rate_limit_info: dict) -> str:
    """allowed_warning용 사람이 읽을 수 있는 안내문 생성.

    Args:
        rate_limit_info: rate_limit_event의 rate_limit_info 딕셔너리

    Returns:
        "⚠️ 주간 사용량 중 51%를 넘었습니다" 형태의 안내문
    """
    raw_type = rate_limit_info.get("rateLimitType", "")
    type_ko = _RATE_LIMIT_TYPE_KO.get(raw_type, raw_type)
    utilization = rate_limit_info.get("utilization", 0)
    pct = int(utilization * 100)
    return f"⚠️ {type_ko} 사용량 중 {pct}%를 넘었습니다"


# 디버그 메시지 전송 콜백 타입: (message) -> None
DebugSendFn = Callable[[str], None]


