"""AgentProfile.backend 필드 회귀 (옵션 D Phase A — A2).

agents.yaml의 `backend` 키가 AgentProfile.backend로 dispatch되는지 검증.
키 부재 시 default "claude" — 후방호환.
"""
import textwrap

from soul_server.service.agent_registry import load_agent_registry


def test_default_backend_claude(tmp_path):
    """agents.yaml에 backend 키 부재 시 default "claude"."""
    yaml_file = tmp_path / "agents.yaml"
    yaml_file.write_text(textwrap.dedent("""
        agents:
          - id: foo
            name: Foo
            workspace_dir: /tmp/foo
    """).strip())
    registry = load_agent_registry(str(yaml_file))
    profile = registry.get("foo")
    assert profile is not None
    assert profile.backend == "claude"


def test_explicit_backend_codex(tmp_path):
    """agents.yaml에 backend: codex 명시 시 그대로 dispatch."""
    yaml_file = tmp_path / "agents.yaml"
    yaml_file.write_text(textwrap.dedent("""
        agents:
          - id: cody
            name: Cody
            workspace_dir: /tmp/cody
            backend: codex
    """).strip())
    registry = load_agent_registry(str(yaml_file))
    profile = registry.get("cody")
    assert profile is not None
    assert profile.backend == "codex"
