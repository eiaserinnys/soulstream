"""Soulstream service reflector setup.

Creates and configures a :class:`cogito.Reflector` for the soulstream-server
so that it appears correctly in the cogito manifest and responds to
``/reflect`` requests.
"""

from __future__ import annotations

from pathlib import Path

from cogito import Reflector


def create_reflector(port: int) -> Reflector:
    """Create and return the soulstream-server Reflector.

    Args:
        port: The port the soul-server is listening on.

    Returns:
        Configured :class:`Reflector` instance.
    """
    # source_root = soul-server/ (where pyproject.toml lives)
    # __file__ = soul_server/cogito/reflector_setup.py
    # parents: [0]=cogito, [1]=soul_server, [2]=src, [3]=soul-server
    source_root = str(Path(__file__).resolve().parents[3])

    reflect = Reflector(
        name="soulstream-server",
        description=(
            "Claude Code 원격 실행 서비스. "
            "세션 관리, 크레덴셜 프로필 관리, 러너 풀, LLM 프록시 기능을 제공한다."
        ),
        source_root=source_root,
        port=port,
    )

    # --- Capabilities ---

    reflect.declare_capability(
        name="session_management",
        description="Claude Code 세션 생성, 목록 조회, SSE 스트리밍",
        tools=["execute", "sessions_list", "sessions_stream"],
    )

    reflect.declare_capability(
        name="credential_management",
        description="Claude 계정 프로필 관리, 크레덴셜 교체, 레이트 리밋 추적",
    )

    reflect.declare_capability(
        name="runner_pool",
        description="Claude Code 러너 풀 관리, 예열, 유지보수",
    )

    reflect.declare_capability(
        name="llm_proxy",
        description="OpenAI/Anthropic LLM 프록시 (선택 사항)",
    )

    reflect.declare_capability(
        name="cogito",
        description="서비스 리플렉션 데이터 조회 (MCP 도구)",
        tools=["reflect_service", "reflect_brief", "reflect_refresh"],
    )

    # --- Key configuration entries ---

    reflect.declare_config(key="WORKSPACE_DIR", source="env")
    reflect.declare_config(key="PORT", source="env")
    reflect.declare_config(
        key="AUTH_BEARER_TOKEN", source="env", sensitive=True,
    )
    reflect.declare_config(
        key="COGITO_MANIFEST_PATH", source="env", required=False,
    )
    reflect.declare_config(
        key="LLM_OPENAI_API_KEY", source="env", sensitive=True, required=False,
    )
    reflect.declare_config(
        key="LLM_ANTHROPIC_API_KEY", source="env", sensitive=True, required=False,
    )

    return reflect
