import { z } from "zod";
import { AgentBackendSchema } from "@soulstream/model-catalog";
export const CLAUDE_PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AgentsSdkToolSchema = z.object({
  name: z.string().min(1, "agents_sdk.tool.name required"),
  description: z.string().default(""),
  needs_approval: z.boolean().default(false),
  parameters: z.record(z.string(), z.unknown()).optional(),
  output: z.string().optional(),
});

const AgentsSdkProviderSchema = z.object({
  type: z.literal("openai").default("openai"),
  api_key_env: z.string().min(1, "agents_sdk.provider.api_key_env required").optional(),
  base_url: z.string().min(1).optional(),
  websocket_base_url: z.string().min(1).optional(),
  organization: z.string().min(1).optional(),
  project: z.string().min(1).optional(),
  use_responses: z.boolean().optional(),
  use_responses_websocket: z.boolean().optional(),
  strict_feature_validation: z.boolean().optional(),
  cache_responses_websocket_models: z.boolean().optional(),
});

export const AgentsSdkHostedToolSchema = z.union([
  z.object({
    type: z.literal("web_search"),
    name: z.string().min(1).optional(),
    user_location: z.record(z.string(), z.unknown()).optional(),
    allowed_domains: z.array(z.string().min(1)).optional(),
    search_context_size: z.enum(["low", "medium", "high"]).optional(),
    external_web_access: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("file_search"),
    name: z.string().min(1).optional(),
    vector_store_ids: z
      .array(z.string().min(1))
      .min(1, "agents_sdk.hosted_tools.file_search.vector_store_ids required"),
    max_num_results: z.number().int().positive().optional(),
    include_search_results: z.boolean().optional(),
    ranking_options: z.record(z.string(), z.unknown()).optional(),
    filters: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal("code_interpreter"),
    name: z.string().min(1).optional(),
    include_outputs: z.boolean().optional(),
    container: z.union([z.string().min(1), z.record(z.string(), z.unknown())]).optional(),
  }),
  z.object({
    type: z.literal("tool_search"),
    name: z.literal("tool_search").optional(),
    description: z.string().nullable().optional(),
    parameters: z.unknown().nullable().optional(),
  }),
  z.object({
    type: z.literal("image_generation"),
    name: z.string().min(1).optional(),
    background: z.string().optional(),
    input_fidelity: z.enum(["high", "low"]).nullable().optional(),
    input_image_mask: z.record(z.string(), z.unknown()).optional(),
    model: z.string().min(1).optional(),
    moderation: z.string().optional(),
    output_compression: z.number().int().min(0).max(100).optional(),
    output_format: z.string().optional(),
    partial_images: z.number().int().positive().optional(),
    quality: z.string().optional(),
    size: z.string().optional(),
  }),
  z.object({
    type: z.literal("hosted_mcp"),
    server_label: z.string().min(1, "agents_sdk.hosted_tools.hosted_mcp.server_label required"),
    server_url: z.string().min(1).optional(),
    connector_id: z.string().min(1).optional(),
    authorization: z.string().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    allowed_tools: z.array(z.string().min(1)).optional(),
    defer_loading: z.boolean().optional(),
    server_description: z.string().optional(),
    require_approval: z.union([
      z.literal("never"),
      z.literal("always"),
      z.object({
        never: z.object({
          tool_names: z.array(z.string().min(1)).optional(),
          read_only: z.boolean().optional(),
        }).optional(),
        always: z.object({
          tool_names: z.array(z.string().min(1)).optional(),
          read_only: z.boolean().optional(),
        }).optional(),
      }),
    ]).optional(),
  }),
]).superRefine((tool, ctx) => {
  if (tool.type === "hosted_mcp" && !tool.server_url && !tool.connector_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["server_url"],
      message: "hosted_mcp requires server_url or connector_id",
    });
  }
});

export const AgentsSdkMcpServerSchema = z.union([
  z.object({
    type: z.literal("stdio"),
    name: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    full_command: z.string().min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    cache_tools_list: z.boolean().optional(),
    timeout: z.number().positive().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    type: z.literal("streamable_http"),
    name: z.string().min(1).optional(),
    url: z.string().min(1, "streamable_http mcp server url required"),
    headers: z.record(z.string(), z.string()).optional(),
    cache_tools_list: z.boolean().optional(),
    timeout: z.number().positive().optional(),
    session_id: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("sse"),
    name: z.string().min(1).optional(),
    url: z.string().min(1, "sse mcp server url required"),
    headers: z.record(z.string(), z.string()).optional(),
    cache_tools_list: z.boolean().optional(),
    timeout: z.number().positive().optional(),
  }),
]).superRefine((server, ctx) => {
  if (server.type === "stdio" && !server.command && !server.full_command) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["command"],
      message: "stdio mcp server requires command or full_command",
    });
  }
});

const AgentsSdkAgentSchema = z.object({
  id: z.string().min(1, "agents_sdk.agent.id required"),
  name: z.string().min(1, "agents_sdk.agent.name required"),
  instructions: z.string().min(1, "agents_sdk.agent.instructions required"),
  handoff_description: z.string().optional(),
  model: z.string().optional(),
  handoffs: z.array(z.string()).default([]),
  tools: z.array(AgentsSdkToolSchema).default([]),
  hosted_tools: z.array(AgentsSdkHostedToolSchema).default([]),
  mcp_servers: z.array(AgentsSdkMcpServerSchema).default([]),
  mcp_config: z.object({
    convert_schemas_to_strict: z.boolean().optional(),
    include_server_in_tool_names: z.boolean().optional(),
  }).optional(),
});

const AgentsSdkBlocklistGuardrailSchema = z.object({
  name: z.string().min(1, "agents_sdk.guardrail.name required"),
  pattern: z.string().min(1, "agents_sdk.guardrail.pattern required"),
  message: z.string().optional(),
});

const AgentsSdkConfigSchema = z.object({
  entry_agent: z.string().min(1, "agents_sdk.entry_agent required"),
  provider: AgentsSdkProviderSchema.optional(),
  agents: z.array(AgentsSdkAgentSchema).min(1, "agents_sdk.agents required"),
  max_turns: z.number().int().positive().optional(),
  guardrails: z.object({
    input_blocklist: z.array(AgentsSdkBlocklistGuardrailSchema).default([]),
    output_blocklist: z.array(AgentsSdkBlocklistGuardrailSchema).default([]),
  }).default({ input_blocklist: [], output_blocklist: [] }),
});

export type AgentsSdkConfig = z.infer<typeof AgentsSdkConfigSchema>;
export type AgentsSdkHostedTool = z.infer<typeof AgentsSdkHostedToolSchema>;
export type AgentsSdkMcpServer = z.infer<typeof AgentsSdkMcpServerSchema>;

export const AgentAtomContextSchema = z.object({
  node_id: z.string().regex(UUID_RE, "atom_contexts.node_id must be a UUID"),
  depth: z.number().int().min(0).default(3),
  titles_only: z.boolean().default(false),
  include_ids: z.boolean().optional(),
  mode: z.string().min(1, "atom_contexts.mode must not be empty").optional(),
  applies_when: z.record(z.string(), z.unknown()).optional(),
});

export type AgentAtomContext = z.infer<typeof AgentAtomContextSchema>;

const AgentAliasSchema = z.union([
  z
    .string()
    .trim()
    .min(1, "agent.aliases id must not be empty")
    .transform((id) => ({ id })),
  z.object({
    id: z.string().trim().min(1, "agent.aliases id must not be empty"),
    default_preset: z
      .string()
      .trim()
      .min(1, "agent.aliases default_preset must not be empty")
      .optional(),
  }),
]);

/**
 * yaml의 단일 agent 엔트리 schema. Python `AgentProfile` dataclass와 키 호환.
 */
export const AgentProfileSchema = z.object({
  id: z.string().min(1, "agent.id required"),
  name: z.string().min(1, "agent.name required"),
  backend: AgentBackendSchema,
  aliases: z.array(AgentAliasSchema).optional(),
  default_preset: z
    .string()
    .trim()
    .min(1, "agent.default_preset must not be empty")
    .optional(),
  model: z.string().trim().min(1, "agent.model must not be empty").optional(),
  workspace_dir: z.string().min(1, "agent.workspace_dir required"),
  max_turns: z.number().int().positive().optional(),
  allowed_tools: z.array(z.string()).optional(),
  disallowed_tools: z.array(z.string()).optional(),
  claude_permission_mode: z.enum(CLAUDE_PERMISSION_MODES).optional(),
  env: z.record(z.string(), z.string()).optional(),
  mcp_profile: z.string().min(1).optional(),
  portrait_path: z.string().optional(),
  /**
   * agents.yaml 정본 atom 주입.
   *
   * 각 항목은 atom compile_subtree REST API의
   * node/depth/titles_only/include_ids/mode에 대응한다.
   * ExecutionContextBuilder가 신규 세션 첫 turn의 system prompt 맨 앞에 주입한다.
   */
  atom_contexts: z.array(AgentAtomContextSchema).optional(),
  agents_sdk: AgentsSdkConfigSchema.optional(),
}).superRefine((profile, ctx) => {
  if (profile.backend === "openai-agents" && !profile.agents_sdk) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["agents_sdk"],
      message: "agents_sdk config required when backend is openai-agents",
    });
  }
});

export type AgentProfile = z.infer<typeof AgentProfileSchema>;
