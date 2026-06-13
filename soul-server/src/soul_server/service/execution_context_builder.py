"""ExecutionContextBuilder — TaskExecutor의 컨텍스트 준비 단계 책임.

폴더 설정 조회, atom 트리 fetch, 프로필 해석, 컨텍스트 조립을 담당한다.
TaskExecutor._prepare_context로부터 추출 (260505 분해 시리즈 3단계).
"""
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, TYPE_CHECKING

from soul_server.service.atom_context import fetch_atom_context
from soul_server.service.prompt_assembler import assemble_prompt
from soul_server.service.context_builder import build_soulstream_context_item
from soul_server.service.task_models import Task

if TYPE_CHECKING:
    from soul_server.service.postgres_session_db import PostgresSessionDB
    from soul_server.service.agent_registry import AgentRegistry

logger = logging.getLogger(__name__)


def _resolve_profile_env_value(env_key: str, raw_value: str) -> str:
    """`${VAR}` 형식이면 환경변수를 엄격히 해석하고, 아니면 literal로 둔다."""
    if raw_value.startswith("${") and raw_value.endswith("}"):
        source_key = raw_value[2:-1]
        if not source_key:
            raise RuntimeError(f"agents.yaml env '{env_key}' has an empty variable reference")
        if source_key not in os.environ or os.environ[source_key] == "":
            raise RuntimeError(
                f"agents.yaml env '{env_key}' references missing environment variable "
                f"'{source_key}'"
            )
        return os.environ[source_key]
    return raw_value


def _validate_profile_env_auth_bundle(env: dict[str, str]) -> None:
    """Anthropic-compatible API key env는 base URL과 OAuth 혼합 여부를 검증한다."""
    has_api_key = "ANTHROPIC_API_KEY" in env
    has_base_url = "ANTHROPIC_BASE_URL" in env
    if has_api_key != has_base_url:
        raise RuntimeError(
            "agents.yaml env must set ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL together"
        )
    if has_api_key and "CLAUDE_CODE_OAUTH_TOKEN" in env:
        raise RuntimeError(
            "agents.yaml env cannot mix ANTHROPIC_API_KEY with CLAUDE_CODE_OAUTH_TOKEN"
        )


def _resolve_profile_env(raw_env: Optional[dict[str, str]]) -> Optional[dict[str, str]]:
    """AgentProfile.env를 Claude Code subprocess extra_env로 해석한다."""
    if not raw_env:
        return None
    env = {
        key: _resolve_profile_env_value(key, value)
        for key, value in raw_env.items()
    }
    _validate_profile_env_auth_bundle(env)
    return env


@dataclass
class _PreparedContext:
    """_run_execution의 컨텍스트 준비 단계 결과물"""
    effective_system_prompt: Optional[str] = None
    combined_context_items: list = field(default_factory=list)
    folder_name: Optional[str] = None
    working_dir: Optional[Path] = None
    max_turns: Optional[int] = None
    effective_allowed_tools: Optional[list] = None
    effective_disallowed_tools: Optional[list] = None
    extra_env: Optional[dict] = None
    assembled_prompt: str = ""


class ExecutionContextBuilder:
    """세션 실행 직전의 컨텍스트(_PreparedContext)를 조립한다.

    책임 분해:
      1. _resolve_folder        — 폴더 이름·프롬프트·settings dict 조회
      2. _fetch_atom_context    — folder_settings.atomContextNode가 있고 새 세션이면 atom 트리 fetch
      3. _resolve_profile       — registry에서 profile 조회 후 실행 옵션 추출
      4. _assemble_context      — 위 결과 + task + claude_runner.workspace_dir로 _PreparedContext 조립
    """

    def __init__(
        self,
        *,
        session_db: Optional["PostgresSessionDB"],
        agent_registry: Optional["AgentRegistry"],
    ):
        self._db = session_db
        self._registry = agent_registry

    async def build(self, task: Task, claude_runner) -> _PreparedContext:
        """4 메서드를 결합하여 _PreparedContext를 반환한다."""
        folder_name, folder_prompt, folder_settings = await self._resolve_folder(task)
        atom_md = await self._fetch_atom_context(task, folder_settings)
        working_dir, max_turns, override_tools, override_disallowed, profile_env = (
            self._resolve_profile(task)
        )
        return self._assemble_context(
            task=task,
            claude_runner=claude_runner,
            folder_name=folder_name,
            folder_prompt=folder_prompt,
            atom_context_markdown=atom_md,
            working_dir=working_dir,
            max_turns=max_turns,
            override_tools=override_tools,
            override_disallowed=override_disallowed,
            profile_env=profile_env,
        )

    async def _resolve_folder(
        self, task: Task
    ) -> tuple[Optional[str], Optional[str], Optional[dict]]:
        """세션→폴더 lookup. 새 세션(resume_session_id is None)에서만 folderPrompt 적용 후보가 된다.

        Returns:
            (folder_name, folder_prompt, folder_settings_dict)
            - folder_settings_dict는 isinstance(dict) 검사를 통과한 경우에만 반환되므로,
              호출자는 None 또는 dict로 보장된다.
        """
        folder_name: Optional[str] = None
        folder_prompt: Optional[str] = None
        folder_settings_dict: Optional[dict] = None

        if self._db is None:
            return folder_name, folder_prompt, folder_settings_dict

        session_row = await self._db.get_session(task.agent_session_id)
        if not (session_row and session_row.get("folder_id")):
            return folder_name, folder_prompt, folder_settings_dict

        folder_row = await self._db.get_folder(session_row["folder_id"])
        if not folder_row:
            return folder_name, folder_prompt, folder_settings_dict

        folder_name = folder_row["name"]
        # 새 세션에서만 폴더 프롬프트 + atom 트리 주입 (resume/intervention 제외)
        if task.resume_session_id is None:
            settings = folder_row.get("settings")
            if isinstance(settings, dict):
                folder_settings_dict = settings
                folder_prompt = settings.get("folderPrompt") or None
        return folder_name, folder_prompt, folder_settings_dict

    async def _fetch_atom_context(
        self, task: Task, folder_settings: Optional[dict]
    ) -> Optional[str]:
        """folder_settings.atomContextNode가 dict이면 fetch_atom_context 호출."""
        if folder_settings is None or task.resume_session_id is not None:
            return None
        atom_node_cfg = folder_settings.get("atomContextNode")
        if not (isinstance(atom_node_cfg, dict) and atom_node_cfg.get("nodeId")):
            return None
        return await fetch_atom_context(
            node_id=atom_node_cfg["nodeId"],
            depth=int(atom_node_cfg.get("depth", 3)),
            titles_only=bool(atom_node_cfg.get("titlesOnly", False)),
        )

    def _resolve_profile(
        self, task: Task
    ) -> tuple[
        Optional[Path],
        Optional[int],
        Optional[list],
        Optional[list],
        Optional[dict[str, str]],
    ]:
        """profile_id로 registry 조회 → 실행 옵션과 env override."""
        if task.profile_id and self._registry:
            profile = self._registry.get(task.profile_id)
            if profile:
                profile_env = profile.env if isinstance(profile.env, dict) else None
                return (
                    profile.workspace_dir,
                    profile.max_turns,
                    profile.allowed_tools,
                    profile.disallowed_tools,
                    profile_env,
                )
        return None, None, None, None, None

    def _assemble_context(
        self,
        *,
        task: Task,
        claude_runner,
        folder_name: Optional[str],
        folder_prompt: Optional[str],
        atom_context_markdown: Optional[str],
        working_dir: Optional[Path],
        max_turns: Optional[int],
        override_tools: Optional[list],
        override_disallowed: Optional[list],
        profile_env: Optional[dict[str, str]],
    ) -> _PreparedContext:
        """폴더 프롬프트 prepend, soulstream_item 빌드, items 합산, tools 병합, extra_env, assemble_prompt."""
        # 폴더 프롬프트를 system_prompt에 합산 (새 세션에서만)
        effective_system_prompt = task.system_prompt
        if folder_prompt:
            if effective_system_prompt:
                effective_system_prompt = folder_prompt + "\n\n" + effective_system_prompt
            else:
                effective_system_prompt = folder_prompt

        effective_workspace_dir = working_dir or claude_runner.workspace_dir

        # 서버 컨텍스트 빌드 + 클라이언트 컨텍스트 머지
        soulstream_item = build_soulstream_context_item(
            agent_session_id=task.agent_session_id,
            claude_session_id=task.resume_session_id,
            workspace_dir=effective_workspace_dir,
            folder_name=folder_name,
            agent_id=task.profile_id,
            caller_info=task.caller_info,
        )
        atom_context_items = (
            [{"key": "atom_context", "label": "atom 트리", "content": atom_context_markdown}]
            if atom_context_markdown
            else []
        )
        combined_context_items = (
            [soulstream_item]
            + atom_context_items
            + (task.context_items or [])
        )

        # allowed_tools / disallowed_tools 병합: task 설정 우선, None이면 profile 설정 사용
        effective_allowed_tools = task.allowed_tools if task.allowed_tools is not None else override_tools
        effective_disallowed_tools = task.disallowed_tools if task.disallowed_tools is not None else override_disallowed

        # 프로필 env override + per-task OAuth token 병합.
        # Anthropic-compatible API key 프로필은 OAuth 토큰과 섞지 않는다.
        resolved_profile_env = _resolve_profile_env(profile_env)
        extra_env: dict[str, str] = dict(resolved_profile_env or {})
        if task.oauth_token and "ANTHROPIC_API_KEY" not in extra_env:
            extra_env["CLAUDE_CODE_OAUTH_TOKEN"] = task.oauth_token

        assembled_prompt = assemble_prompt(task.prompt, task.context)

        return _PreparedContext(
            effective_system_prompt=effective_system_prompt,
            combined_context_items=combined_context_items,
            folder_name=folder_name,
            working_dir=working_dir,
            max_turns=max_turns,
            effective_allowed_tools=effective_allowed_tools,
            effective_disallowed_tools=effective_disallowed_tools,
            extra_env=extra_env or None,
            assembled_prompt=assembled_prompt,
        )
