"""
Soulstream 서버 초기화 단계별 bootstrap 함수.

main.py lifespan()에서 호출하는 단계별 초기화 함수를 모아 둔다.
각 함수는 하나의 서브시스템을 초기화하고 결과 객체를 반환한다.

startup/shutdown 합성(``startup_lifespan`` / ``shutdown_lifespan``)은 별도 모듈
``soul_server.bootstrap_lifespan``이 정본 (design-principles §2; module-size-limit).
"""

import asyncio
import logging
from pathlib import Path
from typing import Optional

from fastapi import FastAPI

from soul_common.auth.caller_info import build_system_caller_info

from soul_server.claude.agent_runner import ClaudeRunner
from soul_server.config import Settings
from soul_server.service import resource_manager
from soul_server.service.agent_registry import AgentRegistry, load_agent_registry
from soul_server.service.engine_adapter import init_soul_engine, get_soul_engine
from soul_server.service.runner_pool import RunnerPool
from soul_server.service.session_broadcaster import init_session_broadcaster
from soul_server.service.task_manager import TaskManager, set_task_manager

logger = logging.getLogger(__name__)


# ── AgentRegistry 전역 접근자 ───────────────────────────────────
# main.py에서 이관. 여러 모듈이 지연 import로 참조하므로 위치만 변경.

_agent_registry: Optional[AgentRegistry] = None


def get_agent_registry() -> AgentRegistry:
    """lifespan 이후에는 항상 AgentRegistry 인스턴스가 보장됨."""
    if _agent_registry is None:
        raise RuntimeError("AgentRegistry가 초기화되지 않았습니다. lifespan 이전에 호출되었습니다.")
    return _agent_registry


def set_agent_registry(registry: AgentRegistry) -> None:
    global _agent_registry
    _agent_registry = registry


# ── 단계별 초기화 함수 ──────────────────────────────────────────

def bootstrap_runner_pool(settings: Settings) -> RunnerPool:
    """RunnerPool 생성. pre-warm과 maintenance 시작은 lifespan에서 별도로 호출."""
    mcp_config_path = Path(settings.workspace_dir) / ".mcp.json"
    if not mcp_config_path.exists():
        logger.warning(f"  MCP config not found: {mcp_config_path}")
        mcp_config_path = None
    pool = RunnerPool(
        runner_factory=ClaudeRunner,
        max_size=settings.runner_pool_max_size,
        idle_ttl=settings.runner_pool_idle_ttl,
        workspace_dir=settings.workspace_dir,
        allowed_tools=settings.warmup_allowed_tools,
        disallowed_tools=settings.warmup_disallowed_tools,
        mcp_config_path=mcp_config_path,
        min_generic=settings.runner_pool_min_generic,
        maintenance_interval=settings.runner_pool_maintenance_interval,
    )
    logger.info(
        f"  Runner pool initialized: max_size={settings.runner_pool_max_size}, "
        f"idle_ttl={settings.runner_pool_idle_ttl}s, "
        f"min_generic={settings.runner_pool_min_generic}, "
        f"warmup_tools={settings.warmup_allowed_tools}"
    )
    return pool


def bootstrap_cogito(settings: Settings):
    """Cogito BriefComposer 초기화. 설정이 없으면 None을 반환."""
    if not settings.cogito_manifest_path:
        logger.info("  Cogito brief composer: disabled (COGITO_MANIFEST_PATH not set)")
        return None

    from soul_server.cogito.brief_composer import BriefComposer
    from soul_server.cogito.mcp_tools import init as init_cogito_mcp

    cogito_output_dir = str(Path(settings.workspace_dir) / ".claude" / "rules" / "cogito")
    brief_composer = BriefComposer(
        manifest_path=settings.cogito_manifest_path,
        output_dir=cogito_output_dir,
    )
    init_cogito_mcp(
        brief_composer=brief_composer,
        manifest_path=settings.cogito_manifest_path,
    )
    logger.info(f"  Cogito brief composer: manifest={settings.cogito_manifest_path}")
    logger.info("  Cogito MCP tools: initialized")
    return brief_composer


async def bootstrap_session_db(settings: Settings):
    """SessionDB 생성·연결. PostgreSQL / SQLite 자동 분기."""
    from soul_server.service.postgres_session_db import (
        create_soul_server_session_db, create_soul_server_sqlite_db,
        init_session_db,
    )

    data_dir = Path(settings.data_dir)

    if settings.database_url:
        session_db = create_soul_server_session_db(
            database_url=settings.database_url,
            node_id=settings.soulstream_node_id,
        )
        await session_db.connect()
        await session_db.ensure_default_folders()
        init_session_db(session_db)
        logger.info(f"  PostgresSessionDB initialized: node_id={settings.soulstream_node_id}")

        # 레거시 데이터 자동 이관 (SQLite/JSONL → PostgreSQL)
        from soul_server.migration import auto_migrate
        await auto_migrate(session_db, settings.data_dir)
    else:
        sqlite_path = settings.sqlite_path
        data_dir.mkdir(parents=True, exist_ok=True)
        session_db = create_soul_server_sqlite_db(
            sqlite_path=sqlite_path,
            node_id=settings.soulstream_node_id,
        )
        await session_db.connect()
        await session_db.ensure_default_folders()
        init_session_db(session_db)
        logger.info(f"  SqliteSessionDB initialized: path={sqlite_path}, node_id={settings.soulstream_node_id}")

    return session_db


def bootstrap_metadata_extractor(data_dir: Path):
    """MetadataExtractor 초기화. 부가 기능 — 로드 실패해도 None 반환."""
    metadata_rules_path = data_dir / "metadata_rules.yaml"
    if not metadata_rules_path.exists():
        metadata_rules_path = Path(__file__).parent.parent.parent / "data" / "metadata_rules.yaml"
    try:
        from soul_server.service.metadata_extractor import MetadataExtractor
        extractor = MetadataExtractor(metadata_rules_path)
        logger.info(f"  MetadataExtractor loaded: {metadata_rules_path}")
        return extractor
    except FileNotFoundError:
        logger.info(f"  MetadataExtractor skipped: {metadata_rules_path} not found")
        return None
    except Exception:
        logger.warning("  MetadataExtractor initialization failed", exc_info=True)
        return None


def bootstrap_agent_registry(settings: Settings) -> AgentRegistry:
    """AgentRegistry 로드 및 전역 등록."""
    if settings.agents_config_file:
        registry = load_agent_registry(settings.agents_config_file)
    else:
        registry = AgentRegistry([])  # degraded mode
    set_agent_registry(registry)
    logger.info(f"  AgentRegistry initialized: {len(registry.list())}개 에이전트")
    return registry


async def bootstrap_task_manager(
    session_db,
    settings: Settings,
    metadata_extractor,
    agent_registry: AgentRegistry,
) -> TaskManager:
    """TaskManager 생성·로드·읽음 상태 복구."""
    task_manager = TaskManager(
        session_db=session_db,
        eviction_ttl=settings.session_eviction_ttl_seconds,
        metadata_extractor=metadata_extractor,
        agent_registry=agent_registry,
    )
    set_task_manager(task_manager)

    loaded = await task_manager.load()
    logger.info(f"  Loaded {loaded} sessions from DB")

    # 꼬인 읽음 상태 복구 (완료 세션의 last_read_event_id=0 → last_event_id로)
    await session_db.repair_broken_read_positions()

    return task_manager


async def bootstrap_llm(
    settings: Settings,
    task_manager: TaskManager,
    session_db,
    broadcaster,
    app: FastAPI,
):
    """LLM 어댑터·라우터 초기화. 키가 없으면 None 반환."""
    from soul_server.llm import OpenAIAdapter, AnthropicAdapter, LlmExecutor
    from soul_server.api.llm import create_llm_router

    llm_adapters: dict = {}
    if settings.llm_openai_api_key:
        llm_adapters["openai"] = OpenAIAdapter(api_key=settings.llm_openai_api_key)
        logger.info("  LLM adapter initialized: openai")
    if settings.llm_anthropic_api_key:
        llm_adapters["anthropic"] = AnthropicAdapter(api_key=settings.llm_anthropic_api_key)
        logger.info("  LLM adapter initialized: anthropic")

    if not llm_adapters:
        logger.info("  LLM proxy skipped: no API keys configured")
        return None

    llm_executor = LlmExecutor(
        adapters=llm_adapters,
        task_manager=task_manager,
        session_db=session_db,
        session_broadcaster=broadcaster,
        # R-3 (atom G-6, 2026-05-11): build_system_caller_info fallback에 사용.
        # design-principles §6 정합 (전달은 파라미터로). bootstrap이 settings에서 주입.
        node_id=settings.soulstream_node_id,
    )
    llm_router = create_llm_router(executor=llm_executor)
    app.include_router(llm_router, tags=["llm"])
    logger.info(f"  LLM proxy initialized: providers={list(llm_adapters.keys())}")
    return llm_executor


async def bootstrap_upstream(
    settings: Settings,
    task_manager: TaskManager,
    broadcaster,
    session_db,
    agent_registry: AgentRegistry,
):
    """UpstreamAdapter 초기화 및 시작. 비활성이면 (None, None) 반환."""
    if not settings.soulstream_upstream_enabled:
        logger.info("  UpstreamAdapter disabled (standalone mode)")
        return None, None

    from soul_server.cogito.mcp_tools import init_multi_node_tools
    init_multi_node_tools(settings)

    from soul_server.upstream import UpstreamAdapter

    upstream_adapter = UpstreamAdapter(
        task_manager=task_manager,
        soul_engine=get_soul_engine(),
        resource_manager=resource_manager,
        session_broadcaster=broadcaster,
        upstream_url=settings.soulstream_upstream_url,
        node_id=settings.soulstream_node_id,
        session_db=session_db,
        host=settings.host,
        port=settings.port,
        agent_registry=agent_registry,
        user_name=settings.dash_user_name,
        user_portrait_path=settings.dash_user_portrait,
        auth_bearer_token=settings.auth_bearer_token,
    )
    upstream_task = asyncio.create_task(upstream_adapter.run())
    logger.info(
        "  UpstreamAdapter started: url=%s, node_id=%s",
        settings.soulstream_upstream_url,
        settings.soulstream_node_id,
    )
    return upstream_adapter, upstream_task


async def resume_shutdown_sessions(
    session_db, task_manager: TaskManager, settings: Settings
):
    """이전 종료 시 저장된 세션을 재개한다.

    F-11D fix(2026-05-09, atom F-11): 서버 재시작 안내 인터벤션에 source="system"
    caller_info를 박아 클라이언트가 시스템 발신을 정확히 식별하게 한다 (이전엔
    caller_info=None → dashboard owner portrait fallback). settings.soulstream_node_id를
    위해 시그니처에 settings 인자 추가 (호출자 bootstrap_lifespan.py:168 동시 갱신).
    """
    shutdown_sessions = await session_db.get_shutdown_sessions()
    if not shutdown_sessions:
        return

    system_caller_info = build_system_caller_info(node_id=settings.soulstream_node_id)
    try:
        for s in shutdown_sessions:
            try:
                result = await task_manager.add_intervention(
                    s["session_id"],
                    "소울스트림 서버 재시작이 완료되었습니다. 이전에 진행하던 작업을 재개해주세요.",
                    user="system",
                    caller_info=system_caller_info,
                )
                if result.get("auto_resumed"):
                    await task_manager.executor.start_execution(
                        agent_session_id=s["session_id"],
                        claude_runner=get_soul_engine(),
                        resource_manager=resource_manager,
                    )
                    logger.info(f"  세션 재개 실행 시작: {s['session_id']}")
            except Exception as e:
                logger.warning(f"  세션 재개 실패 ({s['session_id']}): {e}")
        logger.info(f"  이전 세션 재개 메시지 전송: {len(shutdown_sessions)}개")
    except Exception as e:
        logger.warning(f"  shutdown session resume 실패: {e}")
    finally:
        await session_db.clear_shutdown_flags()

