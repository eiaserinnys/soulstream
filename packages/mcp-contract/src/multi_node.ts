import { z } from "zod";
import type { McpToolDefinition } from "./tool_definitions.js";
import { AgentProfileSchema } from "@soulstream/agent-profile-contract";
import { MODEL_REASONING_EFFORTS } from "@soulstream/model-catalog";
const ReasoningEffortToolSchema = z.enum(MODEL_REASONING_EFFORTS);

export const clusterTools = {
  list_nodes: { name: "list_nodes", audience: "all", config: {
      description: "오케스트레이터에 연결된 노드 목록 조회.",
      inputSchema: {},
    } },
  list_node_agents: { name: "list_node_agents", audience: "all", config: {
      description: "특정 노드의 에이전트 목록 조회.",
      inputSchema: { node_id: z.string().min(1) },
    } },
  list_node_model_presets: { name: "list_node_model_presets", audience: "all", config: {
      description:
        "특정 노드가 광고한 모델 preset id와 현재 가용성·사용량 경고를 조회.",
      inputSchema: { node_id: z.string().min(1) },
    } },
  reflect_cluster_brief: { name: "reflect_cluster_brief", audience: "all", config: {
      description:
        "오케스트레이터를 통해 연결된 TS 노드들의 reflect_brief를 집계한다. 로컬 reflect_brief(self-only)와 별도 도구다.",
      inputSchema: {},
    } },
  plan_remote_agent_profile_update: { name: "plan_remote_agent_profile_update", audience: "all", timeoutMs: 35000, config: {
      description:
        "오케스트레이터를 통해 대상 노드에 agent profile 변경 계획(diff)만 요청한다. 파일 쓰기와 snapshot 생성은 하지 않는다.",
      inputSchema: {
        node_id: z.string().min(1),
        profile: AgentProfileSchema,
        create_if_missing: z.boolean().default(false),
        include_text_diff: z.boolean().optional(),
        includeTextDiff: z.boolean().optional(),
      },
    } },
  apply_remote_agent_profile_update: { name: "apply_remote_agent_profile_update", audience: "internal", timeoutMs: 35000, config: {
      description:
        "오케스트레이터를 통해 대상 노드에 agent profile 변경을 실제 적용한다. 파일 write/snapshot/reload는 대상 노드에서 수행한다.",
      inputSchema: {
        node_id: z.string().min(1),
        profile: AgentProfileSchema,
        create_if_missing: z.boolean().default(false),
        include_text_diff: z.boolean().optional(),
        includeTextDiff: z.boolean().optional(),
        expected_config_checksum: z.string().optional(),
        expectedConfigChecksum: z.string().optional(),
      },
    } },
  list_remote_agents_config_snapshots: { name: "list_remote_agents_config_snapshots", audience: "all", config: {
      description:
        "오케스트레이터를 통해 대상 노드의 agents.yaml snapshot 목록을 조회한다.",
      inputSchema: { node_id: z.string().min(1) },
    } },
  rollback_remote_agents_config: { name: "rollback_remote_agents_config", audience: "internal", timeoutMs: 35000, config: {
      description:
        "오케스트레이터를 통해 대상 노드의 agents.yaml을 snapshot path 또는 snapshot id로 rollback한다.",
      inputSchema: {
        node_id: z.string().min(1),
        snapshot_path: z.string().optional(),
        snapshot_id: z.string().optional(),
        include_text_diff: z.boolean().optional(),
        includeTextDiff: z.boolean().optional(),
      },
    } },
  create_remote_agent_session: { name: "create_remote_agent_session", audience: "all", timeoutMs: 35000, config: {
      description:
        "다른 노드에 새 에이전트 세션을 생성한다. caller_info(v1)를 자동 조립하여 원격 노드로 전파. notify_completion=false는 카드가 추적 표면일 때 권장.",
      inputSchema: {
        node_id: z.string().min(1),
        agent_id: z.string().optional(),
        model_preset: z.string().min(1).optional(),
        /** Omit to use the selected model preset's advertised default effort. */
        reasoning_effort: ReasoningEffortToolSchema.optional(),
        prompt: z.string(),
        caller_session_id: z.string().optional(),
        notify_completion: z.boolean().optional(),
        folder_id: z.string().nullable().optional(),
        card_id: z.string().optional(),
      },
    } },
} as const satisfies Record<string, McpToolDefinition>;
