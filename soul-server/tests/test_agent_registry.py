"""AgentRegistry 유닛 테스트"""
import os
import tempfile
import pytest
from soul_server.service.agent_registry import AgentProfile, AgentRegistry, load_agent_registry


class TestAgentRegistry:
    def test_get_existing_agent(self):
        registry = AgentRegistry([
            AgentProfile(id="foo", name="Foo", workspace_dir="/tmp/foo"),
        ])
        agent = registry.get("foo")
        assert agent is not None
        assert agent.name == "Foo"

    def test_get_missing_agent_returns_none(self):
        registry = AgentRegistry([])
        assert registry.get("nonexistent") is None

    def test_has(self):
        registry = AgentRegistry([
            AgentProfile(id="foo", name="Foo", workspace_dir="/tmp/foo"),
        ])
        assert registry.has("foo") is True
        assert registry.has("bar") is False

    def test_list(self):
        profiles = [
            AgentProfile(id="a", name="A", workspace_dir="/tmp/a"),
            AgentProfile(id="b", name="B", workspace_dir="/tmp/b"),
        ]
        registry = AgentRegistry(profiles)
        assert len(registry.list()) == 2


class TestLoadAgentRegistry:
    def test_load_valid_yaml(self, tmp_path):
        yaml_content = """
agents:
  - id: seosoyoung
    name: 서소영
    workspace_dir: /tmp/workspace
    portrait_path: "/tmp/portrait.png"
  - id: ariella
    name: 아리엘라
    workspace_dir: /tmp/ariella
    max_turns: 1
"""
        config_file = tmp_path / "agents.yaml"
        config_file.write_text(yaml_content, encoding="utf-8")
        registry = load_agent_registry(str(config_file))
        assert len(registry.list()) == 2
        ssy = registry.get("seosoyoung")
        assert ssy is not None
        assert ssy.name == "서소영"
        ariella = registry.get("ariella")
        assert ariella is not None
        assert ariella.max_turns == 1

    def test_load_unknown_key_raises_runtime_error(self, tmp_path):
        yaml_content = """
agents:
  - id: foo
    name: Foo
    workspace_dir: /tmp/foo
    unknown_field: value
"""
        config_file = tmp_path / "agents.yaml"
        config_file.write_text(yaml_content, encoding="utf-8")
        with pytest.raises(RuntimeError, match="agents.yaml 파싱 오류"):
            load_agent_registry(str(config_file))

    def test_empty_agents_list(self, tmp_path):
        yaml_content = "agents: []\n"
        config_file = tmp_path / "agents.yaml"
        config_file.write_text(yaml_content, encoding="utf-8")
        registry = load_agent_registry(str(config_file))
        assert registry.list() == []

    def test_missing_required_field_raises_runtime_error(self, tmp_path):
        yaml_content = """
agents:
  - name: NoIdAgent
    workspace_dir: /tmp
"""
        config_file = tmp_path / "agents.yaml"
        config_file.write_text(yaml_content, encoding="utf-8")
        with pytest.raises(RuntimeError, match="agents.yaml 파싱 오류"):
            load_agent_registry(str(config_file))
