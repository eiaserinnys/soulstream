"""
Claude CLI 실행 및 파싱

subprocess로 `claude setup-token`을 실행하고
stdout에서 OAuth URL과 토큰을 파싱합니다.
"""

from __future__ import annotations

import asyncio
import logging
import re
import sys
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from asyncio.subprocess import Process

logger = logging.getLogger(__name__)


# URL 패턴: https://claude.ai/oauth/authorize?...
URL_PATTERN = re.compile(rb"(https://claude\.ai/oauth/authorize\?[^\s\n]+)")

# 토큰 패턴: sk-ant-oat01-...
TOKEN_PATTERN = re.compile(rb"(sk-ant-oat01-[A-Za-z0-9_-]+)")

# 코드 입력 프롬프트 패턴
CODE_PROMPT_PATTERN = re.compile(rb"(?:Paste code|code here|prompted)", re.IGNORECASE)


class CliRunnerError(Exception):
    """CLI 실행 중 발생한 오류"""

    pass


@dataclass
class StartResult:
    """CLI 시작 결과"""

    process: "Process"
    auth_url: str


@dataclass
class SubmitResult:
    """코드 제출 결과"""

    token: str


def ensure_proactor_event_loop() -> None:
    """
    Windows에서 ProactorEventLoop 사용 확인

    Windows에서 asyncio.create_subprocess_exec()는
    ProactorEventLoop이 필요합니다.
    SelectorEventLoop에서는 NotImplementedError가 발생합니다.
    """
    if sys.platform != "win32":
        return

    loop = asyncio.get_event_loop()
    # asyncio.ProactorEventLoop은 Windows에서만 존재
    # 따라서 문자열로 클래스 이름 비교
    loop_type = type(loop).__name__
    if "Proactor" not in loop_type:
        raise CliRunnerError(
            f"Windows에서 ProactorEventLoop이 필요합니다. "
            f"현재: {loop_type}. "
            f"uvicorn을 --loop asyncio 없이 실행하거나, "
            f"reload=False로 설정하세요."
        )


async def start_cli() -> StartResult:
    """
    `claude setup-token` CLI 시작

    Returns:
        StartResult: process와 auth_url

    Raises:
        CliRunnerError: CLI 시작 실패 또는 URL 추출 실패
    """
    ensure_proactor_event_loop()

    try:
        process = await asyncio.create_subprocess_exec(
            "claude",
            "setup-token",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
    except FileNotFoundError:
        raise CliRunnerError("'claude' CLI가 PATH에 없습니다")
    except Exception as e:
        raise CliRunnerError(f"CLI 시작 실패: {e}")

    # stdout에서 URL 추출 (프롬프트가 나올 때까지)
    auth_url = await _extract_url(process)

    return StartResult(process=process, auth_url=auth_url)


async def _extract_url(process: "Process", timeout: float = 30.0) -> str:
    """
    stdout에서 OAuth URL 추출

    "Paste code here" 프롬프트가 나오거나 URL이 발견될 때까지 읽습니다.
    """
    if process.stdout is None:
        raise CliRunnerError("stdout이 없습니다")

    buffer = b""
    auth_url: str | None = None

    try:
        async with asyncio.timeout(timeout):
            while True:
                # 작은 청크 단위로 읽기 (프롬프트 감지용)
                chunk = await process.stdout.read(256)
                if not chunk:
                    # EOF - 프로세스 종료
                    break

                buffer += chunk
                logger.debug(f"CLI output chunk: {chunk!r}")

                # URL 패턴 검색
                if auth_url is None:
                    match = URL_PATTERN.search(buffer)
                    if match:
                        auth_url = match.group(1).decode("utf-8")
                        logger.info(f"Found auth URL: {auth_url[:50]}...")

                # 프롬프트 감지 - URL이 있으면 반환
                if CODE_PROMPT_PATTERN.search(buffer) and auth_url:
                    return auth_url

    except asyncio.TimeoutError:
        # 타임아웃이지만 URL이 있으면 반환
        if auth_url:
            return auth_url
        raise CliRunnerError("URL 추출 타임아웃 (30초)")

    # 루프 종료 후 URL 확인
    if auth_url:
        return auth_url

    # URL을 찾지 못함
    output_preview = buffer[:500].decode("utf-8", errors="replace")
    raise CliRunnerError(f"OAuth URL을 찾을 수 없습니다. 출력: {output_preview}")


async def submit_code(process: "Process", code: str, timeout: float = 30.0) -> SubmitResult:
    """
    인증 코드 제출 및 토큰 추출

    Args:
        process: 실행 중인 CLI 프로세스
        code: 사용자가 입력한 인증 코드
        timeout: 토큰 대기 타임아웃 (초)

    Returns:
        SubmitResult: 추출된 토큰

    Raises:
        CliRunnerError: 코드 제출 실패 또는 토큰 추출 실패
    """
    if process.stdin is None:
        raise CliRunnerError("stdin이 없습니다")

    # 코드 전송
    try:
        process.stdin.write(f"{code}\n".encode())
        await process.stdin.drain()
    except Exception as e:
        raise CliRunnerError(f"코드 전송 실패: {e}")

    # 프로세스 완료 대기 및 토큰 추출
    try:
        async with asyncio.timeout(timeout):
            stdout, _ = await process.communicate()
    except asyncio.TimeoutError:
        raise CliRunnerError("토큰 추출 타임아웃 (30초)")

    logger.debug(f"CLI final output: {stdout!r}")

    # 토큰 패턴 검색
    match = TOKEN_PATTERN.search(stdout)
    if match:
        token = match.group(1).decode("utf-8")
        logger.info("Successfully extracted OAuth token")
        return SubmitResult(token=token)

    # 토큰을 찾지 못함
    output_preview = stdout[:500].decode("utf-8", errors="replace")
    raise CliRunnerError(f"토큰을 찾을 수 없습니다. 출력: {output_preview}")
