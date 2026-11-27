import { z } from "zod";
import type { McpToolDefinition } from "./tool_definitions.js";
import { AgentProfilePatchSchema } from "@soulstream/agent-profile-contract";
import { MODEL_REASONING_EFFORTS } from "@soulstream/model-catalog";
const ReasoningEffortToolSchema = z.enum(MODEL_REASONING_EFFORTS);
const AgentAliasToolSchema = z.union([
  z.string().min(1),
  z.object({
    id: z.string().min(1),
    default_preset: z.string().min(1).optional(),
  }),
]);
const AgentAtomContextToolSchema = z.object({
  node_id: z.string().min(1),
  depth: z.number().int().min(0).optional(),
  titles_only: z.boolean().optional(),
  include_ids: z.boolean().optional(),
  mode: z.enum(["full", "index", "titles"]).optional(),
  applies_when: z.record(z.string(), z.unknown()).optional(),
});

export const clusterTools = {
  list_nodes: { name: "list_nodes", audience: "all", config: {
      description: "오케스트레이터에 연결된 노드 목록 조회.",
      inputSchema: {},
    } },
  list_node_agents: { name: "list_node_agents", audience: "all", config: {
      description: "특정 노드의 에이전트 목록 조회. source는 이름·별칭·기본 프리셋이 중앙 프로필(db)에서 왔는지 노드 agents.yaml(yaml)에서 왔는지 보인다.",
      inputSchema: { node_id: z.string().min(1) },
    } },
  get_central_agent_profile: { name: "get_central_agent_profile", audience: "internal", config: {
      description:
        "오케스트레이터 DB의 중앙 에이전트 프로필을 조회한다. 행이 있으면 그 값이 노드 agents.yaml의 같은 칸(name, aliases, default_preset, context_bundles, atom_contexts)을 덮는다. agent_id를 빼면 모든 행의 요약을 돌려준다.",
      inputSchema: { agent_id: z.string().min(1).optional() },
    } },
  update_central_agent_profile: { name: "update_central_agent_profile", audience: "internal", config: {
      description:
        "오케스트레이터 DB의 중앙 에이전트 프로필을 갱신한다. 받은 칸만 덮어쓴다. expected_version이 null이면 새 행을 만든다(이때 name 필수). 행이 있으면 이 값이 노드 agents.yaml의 같은 칸을 덮는다.",
      inputSchema: {
        agent_id: z.string().min(1),
        expected_version: z.number().int().positive().nullable(),
        name: z.string().min(1).optional(),
        default_preset: z.string().nullable().optional(),
        aliases: z.array(AgentAliasToolSchema).optional(),
        context_bundles: z.array(z.string().min(1)).optional(),
        atom_contexts: z.array(AgentAtomContextToolSchema).optional(),
      },
    } },
  delete_central_agent_profile: { name: "delete_central_agent_profile", audience: "internal", config: {
      description:
        "오케스트레이터 DB의 중앙 에이전트 프로필 행을 지운다. 행이 있으면 그 값이 노드 agents.yaml의 같은 칸을 덮었으므로, 지우면 그 칸은 다시 agents.yaml이 정본이 된다.",
      inputSchema: {
        agent_id: z.string().min(1),
        expected_version: z.number().int().positive(),
      },
    } },
  list_node_model_presets: { name: "list_node_model_presets", audience: "all", config: {
      description:
        "특정 노드가 광고한 모델 preset id와 현재 가용성·사용량 경고를 조회. reason이 quota_exhausted면 포함 한도를 다 쓴 것이다. available은 true로 남지만 추가 과금이나 실패가 날 수 있으니 resets_at 뒤에 쓰거나 다른 모델을 고른다. weekly_headroom.window_remaining_percent는 7일 창의 남은 시간 비율이며 사용량 비율이 아니다(남은 사용량 비율은 remaining_percent). weekly_headroom.blocking_quota는 7일 창이 아닌 적용 한도(월 한도 등)가 바닥났을 때의 { label, resets_at }이고, 아니면 null이다. 기본 응답은 판단에 필요한 칸만 담는다(계정 목록과 관측 시각 제외). preset_ids로 필요한 프리셋만 고르고, 계정별 정보까지 보려면 detail: true를 준다.",
      inputSchema: {
        node_id: z.string().min(1),
        preset_ids: z.array(z.string().min(1)).min(1).optional(),
        detail: z.boolean().optional(),
      },
    } },
  reflect_cluster_brief: { name: "reflect_cluster_brief", audience: "all", config: {
      description:
        "오케스트레이터를 통해 연결된 TS 노드들의 reflect_brief를 집계한다. 로컬 reflect_brief(self-only)와 별도 도구다.",
      inputSchema: {},
    } },
  list_event_ingress_dead_letters: { name: "list_event_ingress_dead_letters", audience: "internal", config: {
      description:
        "오케스트레이터의 event ingress dead-letter 디렉터리를 읽기 전용으로 조회한다. state·기간·노드로 거르고 (recorded_at, id) keyset으로 넘긴다. payload 같은 원문 칸은 내지 않는다.",
      inputSchema: {
        state: z.enum(["dead_lettered", "retrying", "all"]).default("dead_lettered"),
        since: z.string().min(1).optional(),
        until: z.string().min(1).optional(),
        node_id: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z.string().min(1).optional(),
      },
      annotations: { readOnlyHint: true },
    } },
  get_event_ingress_delivery_latency: { name: "get_event_ingress_delivery_latency", audience: "internal", timeoutMs: 60000, config: {
      description:
        "orch가 사건을 커밋한 시각(event_ingress_receipts.created_at)에서 노드가 만든 시각(events.created_at)을 뺀 전달 지연을 조회한다. 기간은 7일 이하만 받고 overall·노드별 count와 p50/p90/p99/max, 느린 5건을 낸다.",
      inputSchema: {
        since: z.string().min(1).optional(),
        until: z.string().min(1).optional(),
        node_id: z.string().min(1).optional(),
      },
      annotations: { readOnlyHint: true },
    } },
  plan_remote_agent_profile_update: { name: "plan_remote_agent_profile_update", audience: "all", timeoutMs: 35000, config: {
      description:
        "오케스트레이터를 통해 대상 노드에 agent profile 변경 계획(diff)만 요청한다. 넘긴 최상위 필드만 바꾸고 생략한 필드는 보존하며 null은 삭제한다. 중첩 객체는 통째로 교체한다. 파일 쓰기와 snapshot 생성은 하지 않는다.",
      inputSchema: {
        node_id: z.string().min(1),
        profile: AgentProfilePatchSchema,
        create_if_missing: z.boolean().default(false),
        include_text_diff: z.boolean().optional(),
        includeTextDiff: z.boolean().optional(),
      },
    } },
  apply_remote_agent_profile_update: { name: "apply_remote_agent_profile_update", audience: "internal", timeoutMs: 35000, config: {
      description:
        "오케스트레이터를 통해 대상 노드에 agent profile 변경을 적용한다. 넘긴 최상위 필드만 바꾸고 생략한 필드는 보존하며 null은 삭제한다. 중첩 객체는 통째로 교체한다. 파일 write/snapshot/reload는 대상 노드에서 수행한다.",
      inputSchema: {
        node_id: z.string().min(1),
        profile: AgentProfilePatchSchema,
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
  create_remote_agent_session: { name: "create_remote_agent_session", audience: "all", timeoutMs: 45000, config: {
      description:
        "다른 노드에 새 에이전트 세션을 생성한다. caller_info(v1)를 자동 조립하여 원격 노드로 전파. 결과를 기다리는 위임은 notify_completion=true로 설정한다. 완료 알림을 받을 필요가 없을 때만 false를 사용한다. folder_id를 생략하면 호출 세션의 폴더를 물려받고, null을 주면 폴더 없이 만든다. 이 도구로는 워크트리를 붙일 수 없다. 원격 노드에서 워크트리를 쓰려면 이 도구로 그 노드에 세션을 띄우고, 그 세션이 자기 노드에서 create_worktree로 워크트리를 만든 뒤 create_agent_session의 worktree_id로 작업 세션을 만든다.",
      inputSchema: {
        node_id: z.string().min(1),
        agent_id: z.string().optional(),
        model_preset: z.string().min(1).optional(),
        model_preset_fallbacks: z.array(z.string().min(1).refine((item) => item.trim().length > 0)).optional().describe(
          "만들 때와 실행 중 한도에서 차례로 쓸 대체 모델 preset id. 같은 노드 안에서만 쓴다",
        ),
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
