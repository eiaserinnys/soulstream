"""Soulstream service reflector singleton.

모듈 레벨에서 생성되어, @reflect.capability 데코레이터가
inspect 기반으로 소스 위치를 자동 추적할 수 있게 한다.
"""

from __future__ import annotations

from pathlib import Path

from cogito import Reflector

from soul_server.config import get_settings

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
    port=get_settings().port,
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
