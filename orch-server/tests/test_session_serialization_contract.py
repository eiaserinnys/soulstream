"""Shared session serialization contract fixture tests."""

import json
from pathlib import Path
from unittest.mock import MagicMock

from soulstream_server.api.session_serializer import _session_to_response
from soulstream_server.nodes.node_manager import NodeManager


CONTRACT_PATH = (
    Path(__file__).parents[2]
    / "packages"
    / "wire-schema"
    / "fixtures"
    / "session_serialization_contract.json"
)


def _load_case() -> dict:
    data = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
    return data["cases"][0]


def test_orch_session_to_response_matches_shared_contract_fixture():
    case = _load_case()
    node_manager = MagicMock(spec=NodeManager)
    node_manager.find_agent_profile.return_value = (
        case["orchAgentProfile"],
        case["nodeId"],
    )
    node_manager.get_user_info.return_value = {}

    result = _session_to_response(case["orchDbRow"], node_manager=node_manager)

    assert result == case["expectedOrchResponse"]
