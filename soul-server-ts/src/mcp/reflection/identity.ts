export const REFLECTION_SCHEMA_VERSION = "soulstream.reflect.v1";
export const SELF_SERVICE_NAME = "soul-server-ts";

export const SELF_IDENTITY = {
  name: SELF_SERVICE_NAME,
  description:
    "Soulstream Codex 전담 노드 (TS) — Codex CLI Streamable HTTP MCP 진입점.",
  capabilities: [
    {
      name: "cogito",
      description: "서비스 리플렉션 데이터 조회 (MCP 도구)",
      tools: ["reflect_service", "reflect_brief", "reflect_refresh"],
    },
    {
      name: "session_query",
      description: "세션·이벤트 조회",
      tools: [
        "list_sessions",
        "list_session_events",
        "get_session_event",
        "download_session_history",
        "search_session_history",
        "get_session_summary",
      ],
    },
    {
      name: "session_mgmt",
      description: "에이전트 세션 생성·메시지·이름",
      tools: [
        "list_local_agents",
        "create_agent_session",
        "send_message_to_session",
        "get_session_name",
        "set_session_name",
      ],
    },
    {
      name: "catalog",
      description: "폴더·세션 카탈로그 mutation",
      tools: [
        "list_folders",
        "list_child_folders",
        "create_folder",
        "rename_folder",
        "delete_folder",
        "move_sessions_to_folder",
        "get_folder_system_prompt",
        "set_folder_system_prompt",
        "delete_session",
      ],
    },
    {
      name: "agent_config",
      description: "agents.yaml agent profile 조회·편집",
      tools: [
        "get_agents_config",
        "list_mcp_registry",
        "list_mcp_profiles",
        "list_agents_config_snapshots",
        "plan_agent_profile_update",
        "update_agent_profile",
        "plan_agent_mcp_profile_update",
        "set_agent_mcp_profile",
        "set_agent_atom_contexts",
        "rollback_agents_config",
      ],
    },
    {
      name: "multi_node",
      description: "오케스트레이터 경유 다른 노드 호출",
      tools: [
        "list_nodes",
        "list_node_agents",
        "reflect_cluster_brief",
        "create_remote_agent_session",
        "plan_remote_agent_profile_update",
        "apply_remote_agent_profile_update",
        "list_remote_agents_config_snapshots",
        "rollback_remote_agents_config",
      ],
    },
  ],
} as const;

export function filterCapabilities(capability?: string) {
  if (!capability) return SELF_IDENTITY.capabilities;
  return SELF_IDENTITY.capabilities.filter((c) => c.name === capability);
}
