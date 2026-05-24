/**
 * AgentRegistry — yaml 기반 agent 프로필 정본 (Phase B-3).
 *
 * Python `service/agent_registry.py`의 *구조*를 참조하되 *코드 복사 아님*
 * (정본 둘 안티패턴 회피, atom d7a1ad86). TS는 zod 검증 + ESM import 기반.
 *
 * yaml schema는 Python과 *키 호환* — 운영 시 두 서비스가 서로 다른 yaml 파일을
 * 사용 가능하나 같은 키 구조 유지.
 */

import fs from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

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

const AgentsSdkHostedToolSchema = z.union([
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

const AgentsSdkMcpServerSchema = z.union([
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

export const AgentAtomContextSchema = z.object({
  node_id: z.string().regex(UUID_RE, "atom_contexts.node_id must be a UUID"),
  depth: z.number().int().min(0).default(3),
  titles_only: z.boolean().default(false),
});

export type AgentAtomContext = z.infer<typeof AgentAtomContextSchema>;

/**
 * yaml의 단일 agent 엔트리 schema. Python `AgentProfile` dataclass와 키 호환.
 */
export const AgentProfileSchema = z.object({
  id: z.string().min(1, "agent.id required"),
  name: z.string().min(1, "agent.name required"),
  backend: z.enum(["claude", "codex", "openai-agents"]),
  workspace_dir: z.string().min(1, "agent.workspace_dir required"),
  max_turns: z.number().int().positive().optional(),
  allowed_tools: z.array(z.string()).optional(),
  disallowed_tools: z.array(z.string()).optional(),
  portrait_path: z.string().optional(),
  /**
   * agents.yaml 정본 atom 주입.
   *
   * 각 항목은 atom compile_subtree REST API의 node/depth/titles_only에 대응한다.
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

/** yaml 파일 최상위 schema. */
export const AgentsConfigSchema = z.object({
  agents: z.array(AgentProfileSchema).default([]),
}).superRefine((config, ctx) => {
  const seen = new Set<string>();
  for (const [index, agent] of config.agents.entries()) {
    if (seen.has(agent.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["agents", index, "id"],
        message: `Duplicate agent id in registry: ${agent.id}`,
      });
    }
    seen.add(agent.id);
  }
});

export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;

/**
 * agent 프로필 컬렉션. Python `AgentRegistry`와 동일 인터페이스(`get`/`list`/`has`).
 *
 * 시작 시 agents.yaml을 1회 로딩하고, MCP agents.yaml 편집 도구는 같은 registry
 * 인스턴스의 `replace()`로 프로필 컬렉션을 갱신한다.
 */
export class AgentRegistry {
  private readonly profiles: Map<string, AgentProfile>;

  constructor(profiles: AgentProfile[]) {
    this.profiles = new Map();
    for (const p of profiles) {
      if (this.profiles.has(p.id)) {
        throw new Error(`Duplicate agent id in registry: ${p.id}`);
      }
      this.profiles.set(p.id, p);
    }
  }

  get(id: string): AgentProfile | undefined {
    return this.profiles.get(id);
  }

  list(): AgentProfile[] {
    return Array.from(this.profiles.values());
  }

  has(id: string): boolean {
    return this.profiles.has(id);
  }

  replace(profiles: AgentProfile[]): void {
    const next = new Map<string, AgentProfile>();
    for (const p of profiles) {
      if (next.has(p.id)) {
        throw new Error(`Duplicate agent id in registry: ${p.id}`);
      }
      next.set(p.id, p);
    }
    this.profiles.clear();
    for (const [id, profile] of next) this.profiles.set(id, profile);
  }

  /** 등록된 backend 목록 (중복 제거, registration.supported_backends 산출용). */
  supportedBackends(): string[] {
    const profiles = this.list();
    const set = new Set<string>();
    for (const p of profiles) set.add(p.backend);
    return Array.from(set);
  }
}

export function readAgentsConfig(configPath: string): AgentsConfig {
  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed: unknown = parseYaml(raw) ?? {};
  return AgentsConfigSchema.parse(parsed);
}

export function readAgentsConfigRaw(configPath: string): {
  raw: string;
  parsed: AgentsConfig;
} {
  const raw = fs.readFileSync(configPath, "utf-8");
  const data: unknown = parseYaml(raw) ?? {};
  return {
    raw,
    parsed: AgentsConfigSchema.parse(data),
  };
}

/**
 * yaml 파일에서 AgentRegistry를 로딩한다.
 *
 * - 파일 부재: ENOENT throw — 호출자(main.ts)가 catch하여 명확한 stderr 후 exit(1)
 * - yaml 파싱 오류: YAMLParseError throw
 * - schema 위반: ZodError throw
 * - 중복 agent id: Error throw (`AgentRegistry` constructor)
 *
 * 빈 파일·`agents: []`은 정상 — 빈 registry 반환. node_register agents 광고는 빈 배열.
 */
export function loadAgentRegistry(configPath: string): AgentRegistry {
  const validated = readAgentsConfig(configPath);
  return new AgentRegistry(validated.agents);
}
