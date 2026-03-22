"""
Soulstream - Configuration

환경변수 기반 설정 관리.
"""

import os
import logging
import sys
from functools import lru_cache
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

# find_dotenv()는 소스 코드 경로 기준으로 탐색하므로 CWD의 .env를 찾지 못한다.
# 서비스 CWD의 .env를 명시적으로 로드한다.
load_dotenv(dotenv_path=Path.cwd() / ".env")


def _parse_int(value: str, name: str) -> int:
    """환경변수를 int로 변환. 변환 불가 시 즉시 ValueError.

    Args:
        value: 변환할 문자열
        name: 환경변수 이름 (에러 메시지용)

    Returns:
        변환된 int 값
    """
    try:
        return int(value)
    except (ValueError, TypeError):
        raise ValueError(f"Invalid environment variable {name}='{value}': expected integer")


def _parse_csv_list(value: Optional[str], default: list[str]) -> list[str]:
    """쉼표 구분 문자열을 리스트로 변환

    Args:
        value: 쉼표 구분 문자열 (None이면 기본값 사용)
        default: 기본값

    Returns:
        파싱된 문자열 리스트
    """
    if value is None:
        return default
    return [item.strip() for item in value.split(",") if item.strip()]


def _parse_float(value: str, name: str) -> float:
    """환경변수를 float로 변환. 변환 불가 시 즉시 ValueError.

    Args:
        value: 변환할 문자열
        name: 환경변수 이름 (에러 메시지용)

    Returns:
        변환된 float 값
    """
    try:
        return float(value)
    except (ValueError, TypeError):
        raise ValueError(f"Invalid environment variable {name}='{value}': expected float")


@dataclass
class Settings:
    """애플리케이션 설정"""

    # 서비스 정보
    service_name: str = "soulstream"
    version: str = "0.1.0"
    environment: str = "development"  # development, staging, production

    # 서버 설정
    host: str = "0.0.0.0"
    port: int = 3105

    # 인증
    auth_bearer_token: str = ""  # API Bearer 토큰. 미설정 시 개발 모드에서 우회

    # Claude Code 설정
    workspace_dir: str = ""
    claude_cli_dir: str = ""  # claude CLI가 PATH에 없는 경우 설정

    # 디렉토리
    data_dir: str = ""  # 태스크 저장, 이벤트 로그 등. 미설정 시 {workspace_dir}/.local/data
    incoming_file_dir: str = ""  # 첨부 파일 임시 저장. 미설정 시 {workspace_dir}/.local/incoming

    # 리소스 제한
    max_concurrent_sessions: int = 3
    session_timeout_seconds: int = 1800  # 30분
    session_eviction_ttl_seconds: int = 900  # 완료 세션 메모리 퇴거 TTL (15분)

    # Runner Pool 설정
    runner_pool_max_size: int = 5           # idle pool 최대 크기 (session + generic 합산)
    runner_pool_idle_ttl: float = 300.0     # 유휴 runner TTL (초)
    runner_pool_pre_warm: int = 2           # 기동 시 예열할 generic runner 수
    runner_pool_maintenance_interval: float = 60.0  # 유지보수 루프 실행 간격 (초)
    runner_pool_min_generic: int = 1        # generic pool 최소 유지 수량

    # Warmup 도구 설정
    # 슬랙봇 어드민의 기본 유즈케이스 값 (engine_adapter.py DEFAULT_* 와 동일)
    warmup_allowed_tools: list[str] = field(default_factory=lambda: [
        "Read", "Glob", "Grep", "Task",
        "WebFetch", "WebSearch", "Edit", "Write", "Bash",
    ])
    warmup_disallowed_tools: list[str] = field(default_factory=lambda: [
        "NotebookEdit", "TodoWrite",
    ])

    # 로깅
    log_level: str = "INFO"
    log_format: str = "json"  # json, text

    # 헬스 체크
    health_check_interval: int = 30

    # Serendipity 연동
    serendipity_enabled: bool = True  # 세렌디피티 저장 활성화
    serendipity_url: str = "http://localhost:4002"  # 세렌디피티 API URL

    # LLM Proxy (선택 사항 — 미설정 프로바이더 호출 시 에러)
    llm_openai_api_key: str = ""
    llm_anthropic_api_key: str = ""

    # Cogito (선택 사항 — 미설정 시 브리프 생성 비활성화)
    cogito_manifest_path: str = ""

    # Google OAuth (선택 — 미설정 시 인증 비활성)
    google_client_id: str = ""
    google_client_secret: str = ""
    google_callback_url: str = "/api/auth/google/callback"
    allowed_email: str = ""
    jwt_secret: str = ""

    # PostgreSQL (필수)
    database_url: str = ""                     # postgresql://soulstream:***@host:5432/soulstream
    soulstream_node_id: str = ""               # 노드 식별자 (예: silent-manari)

    # Upstream (소울스트림 연결 — 미설정 시 독립 실행 모드)
    soulstream_upstream_url: str = ""          # ws://soulstream-host:5200/ws/node
    soulstream_upstream_enabled: bool = False   # False면 독립 실행 모드

    # Dashboard profile (선택 사항 — 미설정 시 기본 이름 표시, 초상화 없음)
    dash_user_name: str = "USER"
    dash_user_id: str = ""
    dash_user_portrait: str = ""  # 빈 문자열이면 이미지 없음
    dash_assistant_name: str = "ASSISTANT"
    dash_assistant_id: str = ""
    dash_assistant_portrait: str = ""  # 빈 문자열이면 이미지 없음

    @classmethod
    def from_env(cls) -> "Settings":
        """환경변수에서 설정 로드"""
        workspace_dir = os.getenv("WORKSPACE_DIR", "")

        # 웜업 도구 기본값 (슬랙봇 어드민 유즈케이스)
        _default_warmup_allowed = "Read,Glob,Grep,Task,WebFetch,WebSearch,Edit,Write,Bash"
        _default_warmup_disallowed = "NotebookEdit,TodoWrite"

        settings = cls(
            service_name=os.getenv("SERVICE_NAME", cls.service_name),
            version=os.getenv("SERVICE_VERSION", cls.version),
            environment=os.getenv("ENVIRONMENT", cls.environment),
            host=os.getenv("HOST", cls.host),
            port=_parse_int(os.getenv("PORT", str(cls.port)), "PORT"),
            auth_bearer_token=os.getenv("AUTH_BEARER_TOKEN", ""),
            workspace_dir=workspace_dir,
            claude_cli_dir=os.getenv("CLAUDE_CLI_DIR", ""),
            data_dir=os.getenv("DATA_DIR", ""),
            incoming_file_dir=os.getenv("INCOMING_FILE_DIR", ""),
            max_concurrent_sessions=_parse_int(
                os.getenv("MAX_CONCURRENT_SESSIONS", str(cls.max_concurrent_sessions)),
                "MAX_CONCURRENT_SESSIONS"
            ),
            session_timeout_seconds=_parse_int(
                os.getenv("SESSION_TIMEOUT_SECONDS", str(cls.session_timeout_seconds)),
                "SESSION_TIMEOUT_SECONDS"
            ),
            session_eviction_ttl_seconds=_parse_int(
                os.getenv("SESSION_EVICTION_TTL_SECONDS", str(cls.session_eviction_ttl_seconds)),
                "SESSION_EVICTION_TTL_SECONDS"
            ),
            runner_pool_max_size=_parse_int(
                os.getenv("RUNNER_POOL_MAX_SIZE", str(cls.runner_pool_max_size)),
                "RUNNER_POOL_MAX_SIZE"
            ),
            runner_pool_idle_ttl=_parse_float(
                os.getenv("RUNNER_POOL_IDLE_TTL", str(cls.runner_pool_idle_ttl)),
                "RUNNER_POOL_IDLE_TTL"
            ),
            runner_pool_pre_warm=_parse_int(
                os.getenv("RUNNER_POOL_PRE_WARM", str(cls.runner_pool_pre_warm)),
                "RUNNER_POOL_PRE_WARM"
            ),
            runner_pool_maintenance_interval=_parse_float(
                os.getenv("RUNNER_POOL_MAINTENANCE_INTERVAL", str(cls.runner_pool_maintenance_interval)),
                "RUNNER_POOL_MAINTENANCE_INTERVAL"
            ),
            runner_pool_min_generic=_parse_int(
                os.getenv("RUNNER_POOL_MIN_GENERIC", str(cls.runner_pool_min_generic)),
                "RUNNER_POOL_MIN_GENERIC"
            ),
            warmup_allowed_tools=_parse_csv_list(
                os.getenv("WARMUP_ALLOWED_TOOLS"),
                _default_warmup_allowed.split(","),
            ),
            warmup_disallowed_tools=_parse_csv_list(
                os.getenv("WARMUP_DISALLOWED_TOOLS"),
                _default_warmup_disallowed.split(","),
            ),
            log_level=os.getenv("LOG_LEVEL", cls.log_level),
            log_format=os.getenv("LOG_FORMAT", cls.log_format),
            health_check_interval=_parse_int(
                os.getenv("HEALTH_CHECK_INTERVAL", str(cls.health_check_interval)),
                "HEALTH_CHECK_INTERVAL"
            ),
            serendipity_enabled=os.getenv("SERENDIPITY_ENABLED", "true").lower() in ("true", "1", "yes"),
            serendipity_url=os.getenv("SERENDIPITY_URL", cls.serendipity_url),
            # Cogito
            cogito_manifest_path=os.getenv("COGITO_MANIFEST_PATH", ""),
            # LLM Proxy
            llm_openai_api_key=os.getenv("LLM_OPENAI_API_KEY", ""),
            llm_anthropic_api_key=os.getenv("LLM_ANTHROPIC_API_KEY", ""),
            # Upstream (소울스트림 연결)
            soulstream_upstream_url=os.getenv("SOULSTREAM_UPSTREAM_URL", ""),
            database_url=os.getenv("DATABASE_URL", ""),
            soulstream_node_id=os.getenv("SOULSTREAM_NODE_ID", ""),
            soulstream_upstream_enabled=os.getenv(
                "SOULSTREAM_UPSTREAM_ENABLED", "false"
            ).lower() in ("true", "1", "yes"),
            # Google OAuth
            google_client_id=os.getenv("GOOGLE_CLIENT_ID", ""),
            google_client_secret=os.getenv("GOOGLE_CLIENT_SECRET", ""),
            google_callback_url=os.getenv("GOOGLE_CALLBACK_URL", "/api/auth/google/callback"),
            allowed_email=os.getenv("ALLOWED_EMAIL", ""),
            jwt_secret=os.getenv("JWT_SECRET", ""),
            # Dashboard profile
            dash_user_name=os.getenv("DASH_USER_NAME", "USER"),
            dash_user_id=os.getenv("DASH_USER_ID", ""),
            dash_user_portrait=os.getenv("DASH_USER_PORTRAIT", ""),
            dash_assistant_name=os.getenv("DASH_ASSISTANT_NAME", "ASSISTANT"),
            dash_assistant_id=os.getenv("DASH_ASSISTANT_ID", ""),
            dash_assistant_portrait=os.getenv("DASH_ASSISTANT_PORTRAIT", ""),
        )

        settings.validate()
        return settings

    def validate(self) -> None:
        """필수 설정값 검증. 누락 시 즉시 에러."""
        missing = []
        if not self.workspace_dir:
            missing.append("WORKSPACE_DIR")
        # Google OAuth 활성 시 필수 변수 검증
        if self.google_client_id:
            if not self.google_client_secret:
                missing.append("GOOGLE_CLIENT_SECRET")
            if not self.jwt_secret:
                missing.append("JWT_SECRET")
            elif len(self.jwt_secret) < 32:
                raise RuntimeError(
                    "JWT_SECRET must be at least 32 characters for sufficient entropy."
                )
            if not self.allowed_email:
                missing.append("ALLOWED_EMAIL")
        # node_id와 database_url은 항상 필수
        if not self.soulstream_node_id:
            missing.append("SOULSTREAM_NODE_ID")
        if not self.database_url:
            missing.append("DATABASE_URL")
        # Upstream 활성 시 추가 필수 변수
        if self.soulstream_upstream_enabled:
            if not self.soulstream_upstream_url:
                missing.append("SOULSTREAM_UPSTREAM_URL")
        if missing:
            raise RuntimeError(
                f"필수 환경변수 누락: {', '.join(missing)}. "
                f".env 파일 또는 환경변수를 확인하세요."
            )
        ws = Path(self.workspace_dir)
        if not self.data_dir:
            # 서버 자체 데이터 → 런타임(CWD) 기준
            self.data_dir = str(Path.cwd() / ".local" / "data")
        if not self.incoming_file_dir:
            # 첨부 파일 → Claude Code가 접근해야 하므로 workspace 기준
            self.incoming_file_dir = str(ws / ".local" / "incoming")

    @property
    def is_auth_enabled(self) -> bool:
        return bool(self.google_client_id)

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @property
    def is_development(self) -> bool:
        return self.environment == "development"


@dataclass
class SettingMeta:
    """Settings 필드의 UI/API용 메타데이터"""

    env_key: str           # 환경변수 이름 (예: "MAX_CONCURRENT_SESSIONS")
    label: str             # UI 표시 이름
    description: str       # 설명
    category: str          # 카테고리
    value_type: str        # "str" | "int" | "float" | "bool" | "csv"
    sensitive: bool = False
    hot_reloadable: bool = True
    read_only: bool = False


CATEGORY_LABELS: dict[str, str] = {
    "server": "서버",
    "session": "세션 관리",
    "runner_pool": "러너 풀",
    "warmup": "워밍업 도구",
    "dashboard": "대시보드 프로필",
    "integration": "외부 연동",
    "auth": "인증",
    "llm": "LLM 프록시",
    "upstream": "소울스트림 연결",
    "database": "데이터베이스",
    "paths": "경로 (읽기 전용)",
}

# Settings dataclass의 필드명 → 메타데이터 매핑
# 모든 Settings 필드가 등록되어야 한다 (테스트로 검증).
SETTINGS_REGISTRY: dict[str, SettingMeta] = {
    # --- server ---
    "service_name": SettingMeta("SERVICE_NAME", "서비스 이름", "서비스 식별자", "server", "str", read_only=True),
    "version": SettingMeta("SERVICE_VERSION", "버전", "서비스 버전", "server", "str", read_only=True),
    "environment": SettingMeta("ENVIRONMENT", "실행 환경", "development / staging / production", "server", "str"),
    "host": SettingMeta("HOST", "바인드 주소", "서버가 리슨하는 호스트 주소", "server", "str", hot_reloadable=False),
    "port": SettingMeta("PORT", "포트", "서버 포트 번호", "server", "int", hot_reloadable=False),
    "log_level": SettingMeta("LOG_LEVEL", "로그 레벨", "INFO / DEBUG / WARNING / ERROR", "server", "str"),
    "log_format": SettingMeta("LOG_FORMAT", "로그 포맷", "json 또는 text", "server", "str"),
    "health_check_interval": SettingMeta("HEALTH_CHECK_INTERVAL", "헬스 체크 간격", "헬스 체크 주기 (초)", "server", "int"),
    # --- session ---
    "max_concurrent_sessions": SettingMeta("MAX_CONCURRENT_SESSIONS", "최대 동시 세션", "동시에 실행 가능한 세션 수 (재시작 필요: resource_manager가 init 시 캐시)", "session", "int", hot_reloadable=False),
    "session_timeout_seconds": SettingMeta("SESSION_TIMEOUT_SECONDS", "세션 타임아웃", "세션 타임아웃 (초)", "session", "int"),
    "session_eviction_ttl_seconds": SettingMeta("SESSION_EVICTION_TTL_SECONDS", "완료 세션 퇴거 TTL", "완료된 세션의 메모리 퇴거 TTL (초)", "session", "int"),
    # --- runner_pool (전부 !hot — RunnerPool init 시 캐시) ---
    "runner_pool_max_size": SettingMeta("RUNNER_POOL_MAX_SIZE", "러너 풀 최대 크기", "idle pool 최대 크기 (session + generic 합산)", "runner_pool", "int", hot_reloadable=False),
    "runner_pool_idle_ttl": SettingMeta("RUNNER_POOL_IDLE_TTL", "유휴 러너 TTL", "유휴 runner 생존 시간 (초)", "runner_pool", "float", hot_reloadable=False),
    "runner_pool_pre_warm": SettingMeta("RUNNER_POOL_PRE_WARM", "사전 예열 수", "기동 시 예열할 generic runner 수", "runner_pool", "int", hot_reloadable=False),
    "runner_pool_maintenance_interval": SettingMeta("RUNNER_POOL_MAINTENANCE_INTERVAL", "유지보수 간격", "유지보수 루프 실행 간격 (초)", "runner_pool", "float", hot_reloadable=False),
    "runner_pool_min_generic": SettingMeta("RUNNER_POOL_MIN_GENERIC", "최소 generic 유지", "generic pool 최소 유지 수량", "runner_pool", "int", hot_reloadable=False),
    # --- warmup (전부 !hot) ---
    "warmup_allowed_tools": SettingMeta("WARMUP_ALLOWED_TOOLS", "허용 도구", "워밍업 시 허용할 도구 (쉼표 구분)", "warmup", "csv", hot_reloadable=False),
    "warmup_disallowed_tools": SettingMeta("WARMUP_DISALLOWED_TOOLS", "비허용 도구", "워밍업 시 비허용할 도구 (쉼표 구분)", "warmup", "csv", hot_reloadable=False),
    # --- dashboard ---
    "dash_user_name": SettingMeta("DASH_USER_NAME", "사용자 이름", "대시보드에 표시할 사용자 이름", "dashboard", "str"),
    "dash_user_id": SettingMeta("DASH_USER_ID", "사용자 ID", "사용자 식별자", "dashboard", "str"),
    "dash_user_portrait": SettingMeta("DASH_USER_PORTRAIT", "사용자 초상화", "사용자 초상화 이미지 경로", "dashboard", "str"),
    "dash_assistant_name": SettingMeta("DASH_ASSISTANT_NAME", "어시스턴트 이름", "대시보드에 표시할 어시스턴트 이름", "dashboard", "str"),
    "dash_assistant_id": SettingMeta("DASH_ASSISTANT_ID", "어시스턴트 ID", "어시스턴트 식별자", "dashboard", "str"),
    "dash_assistant_portrait": SettingMeta("DASH_ASSISTANT_PORTRAIT", "어시스턴트 초상화", "어시스턴트 초상화 이미지 경로", "dashboard", "str"),
    # --- integration ---
    "serendipity_enabled": SettingMeta("SERENDIPITY_ENABLED", "세렌디피티 활성화", "세렌디피티 저장 활성화 여부", "integration", "bool"),
    "serendipity_url": SettingMeta("SERENDIPITY_URL", "세렌디피티 URL", "세렌디피티 API URL", "integration", "str"),
    "cogito_manifest_path": SettingMeta("COGITO_MANIFEST_PATH", "Cogito 매니페스트", "cogito 매니페스트 파일 경로", "integration", "str"),
    # --- upstream (전부 !hot — 소울스트림 연결은 init 시 설정) ---
    "soulstream_upstream_url": SettingMeta("SOULSTREAM_UPSTREAM_URL", "Upstream URL", "소울스트림 오케스트레이터 WebSocket URL", "upstream", "str", hot_reloadable=False),
    "soulstream_node_id": SettingMeta("SOULSTREAM_NODE_ID", "노드 ID", "소울스트림 노드 식별자", "upstream", "str", hot_reloadable=False),
    "soulstream_upstream_enabled": SettingMeta("SOULSTREAM_UPSTREAM_ENABLED", "Upstream 활성화", "소울스트림 오케스트레이터 연결 활성화", "upstream", "bool", hot_reloadable=False),
    # --- auth ---
    "auth_bearer_token": SettingMeta("AUTH_BEARER_TOKEN", "API 토큰", "API Bearer 인증 토큰", "auth", "str", sensitive=True),
    "google_client_id": SettingMeta("GOOGLE_CLIENT_ID", "Google Client ID", "Google OAuth 클라이언트 ID", "auth", "str"),
    "google_client_secret": SettingMeta("GOOGLE_CLIENT_SECRET", "Google Client Secret", "Google OAuth 클라이언트 시크릿", "auth", "str", sensitive=True),
    "google_callback_url": SettingMeta("GOOGLE_CALLBACK_URL", "Google Callback URL", "OAuth 콜백 경로", "auth", "str"),
    "allowed_email": SettingMeta("ALLOWED_EMAIL", "허용 이메일", "인증 허용 이메일 주소", "auth", "str"),
    "jwt_secret": SettingMeta("JWT_SECRET", "JWT 시크릿", "JWT 서명 키 (32자 이상)", "auth", "str", sensitive=True),
    # --- llm ---
    "llm_openai_api_key": SettingMeta("LLM_OPENAI_API_KEY", "OpenAI API Key", "LLM 프록시용 OpenAI 키", "llm", "str", sensitive=True),
    "llm_anthropic_api_key": SettingMeta("LLM_ANTHROPIC_API_KEY", "Anthropic API Key", "LLM 프록시용 Anthropic 키", "llm", "str", sensitive=True),
    # --- database ---
    "database_url": SettingMeta("DATABASE_URL", "데이터베이스 URL", "PostgreSQL 연결 URL", "database", "str", sensitive=True, read_only=True),
    # --- paths (전부 read_only) ---
    "workspace_dir": SettingMeta("WORKSPACE_DIR", "워크스페이스 경로", "Claude Code 워크스페이스 디렉토리", "paths", "str", read_only=True),
    "claude_cli_dir": SettingMeta("CLAUDE_CLI_DIR", "Claude CLI 경로", "claude CLI 디렉토리 (PATH에 없는 경우)", "paths", "str", read_only=True),
    "data_dir": SettingMeta("DATA_DIR", "데이터 경로", "태스크 저장, 이벤트 로그 등 (미설정 시 자동 설정)", "paths", "str", read_only=True),
    "incoming_file_dir": SettingMeta("INCOMING_FILE_DIR", "첨부파일 경로", "첨부 파일 임시 저장 (미설정 시 자동 설정)", "paths", "str", read_only=True),
}


@lru_cache
def get_settings() -> Settings:
    """설정 싱글톤 반환"""
    return Settings.from_env()


def setup_logging(settings: Settings | None = None) -> logging.Logger:
    """로깅 설정

    프로덕션: JSON 포맷 (구조화된 로그)
    개발: 텍스트 포맷 (가독성)
    """
    if settings is None:
        settings = get_settings()

    # 기존 핸들러 제거
    root_logger = logging.getLogger()
    for handler in root_logger.handlers[:]:
        root_logger.removeHandler(handler)

    # 로그 레벨 설정
    log_level = getattr(logging, settings.log_level.upper(), logging.INFO)

    if settings.log_format == "json" and settings.is_production:
        # JSON 포맷 (프로덕션)
        import json

        class JsonFormatter(logging.Formatter):
            def format(self, record: logging.LogRecord) -> str:
                log_data = {
                    "timestamp": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
                    "level": record.levelname,
                    "logger": record.name,
                    "message": record.getMessage(),
                    "service": settings.service_name,
                    "environment": settings.environment,
                }

                # 예외 정보 추가
                if record.exc_info:
                    log_data["exception"] = self.formatException(record.exc_info)

                # 추가 속성
                if hasattr(record, "extra"):
                    log_data.update(record.extra)

                return json.dumps(log_data, ensure_ascii=False)

        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(JsonFormatter())
    else:
        # 텍스트 포맷 (개발)
        formatter = logging.Formatter(
            "%(asctime)s - %(name)s - %(levelname)s - %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S"
        )
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(formatter)

    root_logger.addHandler(handler)
    root_logger.setLevel(log_level)

    # uvicorn 로거 레벨 조정
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.error").setLevel(log_level)

    logger = logging.getLogger(settings.service_name)
    logger.setLevel(log_level)

    return logger
