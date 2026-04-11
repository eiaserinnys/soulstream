"""
Claude OAuth 토큰 저장/삭제 유틸리티

두 가지 저장 경로를 지원한다:
1. .env + os.environ: setup-token(headless) 방식. CLAUDE_CODE_OAUTH_TOKEN 환경변수.
2. ~/.claude/.credentials.json: PKCE OAuth(/login) 방식. refreshToken 자동 갱신 지원.

PKCE OAuth로 로그인하면 credentials.json에 저장하고, .env에는 쓰지 않는다.
CLAUDE_CODE_OAUTH_TOKEN 환경변수가 있으면 Claude Code가 credentials.json을 무시하기 때문.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from pathlib import Path

import yaml

logger = logging.getLogger(__name__)

# 환경변수 키
TOKEN_ENV_KEY = "CLAUDE_CODE_OAUTH_TOKEN"
REFRESH_TOKEN_ENV_KEY = "CLAUDE_CODE_OAUTH_REFRESH_TOKEN"

# credentials.json 경로
CREDENTIALS_PATH = Path.home() / ".claude" / ".credentials.json"

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


def _get_token_from_credentials_json() -> str | None:
    """~/.claude/.credentials.json에서 accessToken 반환.

    PKCE OAuth 경로는 이 파일에만 저장하고 환경변수를 쓰지 않으므로
    get_oauth_token()의 fallback으로 사용한다.
    """
    if not CREDENTIALS_PATH.exists():
        return None
    try:
        creds = json.loads(CREDENTIALS_PATH.read_text(encoding="utf-8"))
        return creds.get("claudeAiOauth", {}).get("accessToken")
    except (json.JSONDecodeError, OSError):
        return None


def get_oauth_token() -> str | None:
    """현재 저장된 OAuth 토큰 반환.

    환경변수 우선, 없으면 ~/.claude/.credentials.json에서 조회한다.
    - 환경변수(CLAUDE_CODE_OAUTH_TOKEN): setup-token(레거시) 경로
    - credentials.json: PKCE OAuth 경로 (현재 주 경로)

    Returns:
        토큰 문자열 또는 None
    """
    token = os.environ.get(TOKEN_ENV_KEY)
    if token:
        return token
    return _get_token_from_credentials_json()


def save_oauth_token(token: str, env_path: Path) -> None:
    """OAuth access token을 현재 프로세스 + .env 파일에 저장 (setup-token 방식).

    PKCE OAuth의 경우 이 함수 대신 save_credentials_json()을 사용한다.
    CLAUDE_CODE_OAUTH_TOKEN 환경변수가 있으면 Claude Code가 credentials.json을 무시하기 때문.

    Args:
        token: 저장할 access token (형식 검증은 호출자 책임)
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

    credentials.json도 함께 삭제한다 (PKCE OAuth 토큰 정리).

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

    # 이전 잘못된 구현이 남긴 REFRESH_TOKEN 환경변수도 정리
    if REFRESH_TOKEN_ENV_KEY in os.environ:
        del os.environ[REFRESH_TOKEN_ENV_KEY]
        logger.info(f"Cleaned up legacy os.environ['{REFRESH_TOKEN_ENV_KEY}']")

    # 2. .env 파일에서 삭제
    if env_path.exists():
        lines: list[str] = []
        skip_next_empty = False

        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                # 토큰 라인 제거 (access + legacy refresh)
                if line.startswith(f"{TOKEN_ENV_KEY}="):
                    had_token = True
                    skip_next_empty = True
                    continue

                if line.startswith(f"{REFRESH_TOKEN_ENV_KEY}="):
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

    # 3. credentials.json 삭제
    delete_credentials_json()

    return had_token


def save_credentials_json(
    access_token: str,
    refresh_token: str,
    expires_in: int | None = None,
    scope: str = "",
) -> None:
    """OAuth 크레덴셜을 ~/.claude/.credentials.json에 저장.

    Claude Code /login과 동일한 형식. refreshToken 자동 갱신을 지원한다.
    PKCE OAuth 경로에서만 호출한다 (setup-token 경로는 save_oauth_token 사용).
    """
    expires_at = None
    if expires_in is not None:
        expires_at = int(time.time() * 1000) + expires_in * 1000
    scopes = [s for s in scope.split(" ") if s] if scope else []

    creds: dict = {}
    if CREDENTIALS_PATH.exists():
        try:
            creds = json.loads(CREDENTIALS_PATH.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            creds = {}

    oauth_data: dict = {
        "accessToken": access_token,
        "refreshToken": refresh_token,
    }
    if expires_at is not None:
        oauth_data["expiresAt"] = expires_at
    if scopes:
        oauth_data["scopes"] = scopes
    creds["claudeAiOauth"] = oauth_data

    CREDENTIALS_PATH.parent.mkdir(parents=True, exist_ok=True)
    CREDENTIALS_PATH.write_text(
        json.dumps(creds, indent=2) + "\n", encoding="utf-8"
    )
    logger.info("Saved OAuth credentials to %s", CREDENTIALS_PATH)


def delete_credentials_json() -> bool:
    """~/.claude/.credentials.json에서 claudeAiOauth 섹션 삭제."""
    if not CREDENTIALS_PATH.exists():
        return False
    try:
        creds = json.loads(CREDENTIALS_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return False
    if "claudeAiOauth" not in creds:
        return False
    del creds["claudeAiOauth"]
    CREDENTIALS_PATH.write_text(
        json.dumps(creds, indent=2) + "\n", encoding="utf-8"
    )
    logger.info("Deleted claudeAiOauth from %s", CREDENTIALS_PATH)
    return True


def get_env_path() -> Path:
    """현재 작업 디렉토리의 .env 파일 경로 반환

    soulstream 실행 디렉토리(CWD)의 .env를 사용합니다.
    load_dotenv()가 시작 시 이 파일을 읽으므로, 재시작 후에도 변경이 유지됩니다.
    """
    return Path.cwd() / ".env"


PROFILES_FILENAME = "oauth_token.yaml"


def get_profiles_path() -> Path:
    """oauth_token.yaml 경로 반환 (.env와 같은 CWD 기준)"""
    return Path.cwd() / PROFILES_FILENAME


def load_profiles(profiles_path: Path) -> dict[str, str]:
    """oauth_token.yaml에서 {프로필명: token} dict 반환

    파일이 없거나 비어 있으면 빈 dict 반환.
    형식: {name: {token: sk-ant-oat01-xxx}}
    """
    if not profiles_path.exists():
        return {}
    with open(profiles_path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f)
    if not data or not isinstance(data, dict):
        return {}
    result = {}
    for name, value in data.items():
        if isinstance(value, dict) and isinstance(value.get("token"), str):
            result[str(name)] = value["token"]
    return result


def get_current_profile_name(profiles: dict[str, str]) -> str | None:
    """현재 os.environ 토큰과 일치하는 프로필 이름 반환. 없으면 None."""
    current_token = get_oauth_token()
    if not current_token:
        return None
    for name, token in profiles.items():
        if token == current_token:
            return name
    return None
