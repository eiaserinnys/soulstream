"""NodeConnection.supported_backends 회귀 (옵션 D Phase A — A2).

노드가 지원하는 백엔드 목록을 wire에 운반하는지 검증.
미명시 시 default ["claude"] — 후방호환.
"""
from unittest.mock import MagicMock

from soulstream_server.nodes.node_connection import NodeConnection


def test_supported_backends_default():
    """supported_backends 미명시 시 default ["claude"]."""
    ws = MagicMock()
    node = NodeConnection(ws=ws, node_id="n1")
    assert node.supported_backends == ["claude"]


def test_supported_backends_explicit():
    """supported_backends 명시 시 그대로 저장."""
    ws = MagicMock()
    node = NodeConnection(ws=ws, node_id="n1", supported_backends=["codex"])
    assert node.supported_backends == ["codex"]


def test_to_info_includes_supported_backends():
    """to_info() 출력에 supportedBackends 키 포함."""
    ws = MagicMock()
    node = NodeConnection(
        ws=ws, node_id="n1", supported_backends=["claude", "codex"]
    )
    info = node.to_info()
    assert info["supportedBackends"] == ["claude", "codex"]
    assert "capabilities" in info
