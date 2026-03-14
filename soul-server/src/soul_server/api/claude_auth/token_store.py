"""
Claude OAuth 토큰 저장/삭제 유틸리티

OAuth 토큰을 현재 프로세스(os.environ)와 .env 파일에 동시 저장/삭제합니다.
- os.environ: 다음 Claude Code spawn 시 즉시 반영
- .env: soulstream 재시작 시 자동 로드 (load_dotenv)
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path

logger = logging.getLogger(__name__)

# 환경변수 키
TOKEN_ENV_KEY = "CLAUDE_CODE_OAUTH_TOKEN"

# Claude OAuth 토큰 형식: sk-ant-oat01-{base64-like characters}
_TOKEN_PATTERN = re.compile(r"^sk-ant-oat01-[A-Za-z0-9_-]+$")


def is_valid_token(token: str) -> bool:
    """Claude OAuth 토큰 형식 검증

    Args:
        token: 검증할 토큰 문자열

    Returns:
        유효한 형식이면 True
    """
    if not token:
        return False
    return bool(_TOKEN_PATTERN.match(token.strip()))


def get_oauth_token() -> str | None:
    """현재 저장된 OAuth 토큰 반환

    Returns:
        토큰 문자열 또는 None
    """
    return os.environ.get(TOKEN_ENV_KEY)


def save_oauth_token(token: str, env_path: Path) -> None:
    """OAuth 토큰을 현재 프로세스 + .env 파일에 저장

    Args:
        token: 저장할 토큰 (형식 검증은 호출자 책임)
        env_path: .env 파일 경로
    """
    token = token.strip()

    # 1. 즉시 적용 (다음 Claude Code spawn에 반영)
    os.environ[TOKEN_ENV_KEY] = token
    logger.info(f"Saved OAuth token to os.environ['{TOKEN_ENV_KEY}']")

    # 2. 영구 저장 (soulstream 재시작 시 자동 로드)
    lines: list[str] = []
    token_found = False

    if env_path.exists():
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith(f"{TOKEN_ENV_KEY}="):
                    lines.append(f"{TOKEN_ENV_KEY}={token}\n")
                    token_found = True
                else:
                    lines.append(line)

    if not token_found:
        # 파일 끝에 빈 줄이 없으면 추가
        if lines and not lines[-1].endswith("\n"):
            lines.append("\n")
        lines.append("\n# Claude Code OAuth Token (auto-generated)\n")
        lines.append(f"{TOKEN_ENV_KEY}={token}\n")

    # 부모 디렉토리가 없으면 생성
    env_path.parent.mkdir(parents=True, exist_ok=True)

    with open(env_path, "w", encoding="utf-8") as f:
        f.writelines(lines)
    logger.info(f"Saved OAuth token to {env_path}")


def delete_oauth_token(env_path: Path) -> bool:
    """OAuth 토큰을 현재 프로세스 + .env 파일에서 삭제

    Args:
        env_path: .env 파일 경로

    Returns:
        토큰이 존재했고 삭제되었으면 True, 토큰이 없었으면 False
    """
    had_token = False

    # 1. 환경변수에서 삭제
    if TOKEN_ENV_KEY in os.environ:
        del os.environ[TOKEN_ENV_KEY]
        had_token = True
        logger.info(f"Deleted OAuth token from os.environ['{TOKEN_ENV_KEY}']")

    # 2. .env 파일에서 삭제
    if env_path.exists():
        lines: list[str] = []
        skip_next_empty = False

        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                # 토큰 라인 제거
                if line.startswith(f"{TOKEN_ENV_KEY}="):
                    had_token = True
                    skip_next_empty = True
                    continue

                # 토큰 관련 주석도 제거
                if line.strip() == "# Claude Code OAuth Token (auto-generated)":
                    skip_next_empty = True
                    continue

                # 토큰 제거 후 빈 줄 정리
                if skip_next_empty and line.strip() == "":
                    skip_next_empty = False
                    continue

                skip_next_empty = False
                lines.append(line)

        with open(env_path, "w", encoding="utf-8") as f:
            f.writelines(lines)
        logger.info(f"Deleted OAuth token from {env_path}")

    return had_token


def get_env_path() -> Path:
    """현재 작업 디렉토리의 .env 파일 경로 반환

    soulstream 실행 디렉토리(CWD)의 .env를 사용합니다.
    load_dotenv()가 시작 시 이 파일을 읽으므로, 재시작 후에도 변경이 유지됩니다.
    """
    return Path.cwd() / ".env"
