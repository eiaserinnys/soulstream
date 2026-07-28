from soul_common.auth import build_llm_caller_info


def test_build_llm_caller_info_matches_typescript_contract() -> None:
    assert build_llm_caller_info(node_id="node-llm") == {
        "source": "llm",
        "agent_node": "node-llm",
        "display_name": "External LLM",
        "user_id": None,
        "avatar_url": None,
    }
