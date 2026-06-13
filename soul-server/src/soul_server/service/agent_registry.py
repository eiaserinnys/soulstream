"""
AgentRegistry - 에이전트 프로필 관리

agents.yaml에서 에이전트 프로필을 로딩하여 레지스트리로 제공한다.
"""

from dataclasses import dataclass
from typing import Optional


@dataclass
class AgentProfile:
    id: str
    name: str
    workspace_dir: str
    portrait_path: str = ""
    max_turns: Optional[int] = None
    allowed_tools: Optional[list[str]] = None
    disallowed_tools: Optional[list[str]] = None
    backend: str = "claude"
    env: Optional[dict[str, str]] = None


class AgentRegistry:
    def __init__(self, profiles: list[AgentProfile]):
        self._profiles: dict[str, AgentProfile] = {p.id: p for p in profiles}

    def get(self, profile_id: str) -> Optional[AgentProfile]:
        return self._profiles.get(profile_id)

    def list(self) -> list[AgentProfile]:
        return list(self._profiles.values())

    def has(self, profile_id: str) -> bool:
        return profile_id in self._profiles


def load_agent_registry(config_path: str) -> AgentRegistry:
    """agents.yaml에서 AgentRegistry를 로딩한다.
    YAML 키 → AgentProfile 필드 1:1 대응.
    미지원 키가 포함된 경우 → TypeError로 즉시 실패 (조용한 무시 금지).
    예외가 발생하면 RuntimeError("agents.yaml 파싱 오류: {e}")로 변환하여 전파.
    """
    import yaml
    with open(config_path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}  # 빈 파일이나 주석만 있는 경우 None → 빈 dict
    try:
        profiles = [
            AgentProfile(**_validate_agent_config(agent))
            for agent in data.get("agents", [])
        ]
    except (TypeError, KeyError) as e:
        raise RuntimeError(f"agents.yaml 파싱 오류: {e}") from e
    return AgentRegistry(profiles)


def _validate_agent_config(agent: dict) -> dict:
    """agents.yaml의 구조만 검증한다. env 참조 해석은 실행 시점에 한다."""
    if not isinstance(agent, dict):
        raise TypeError("agent entry must be a mapping")
    env = agent.get("env")
    if env is None:
        return agent
    if not isinstance(env, dict):
        raise TypeError("agent.env must be a mapping")
    if not all(isinstance(k, str) and isinstance(v, str) for k, v in env.items()):
        raise TypeError("agent.env keys and values must be strings")
    return agent
