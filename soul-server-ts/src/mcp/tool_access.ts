import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { callWithReferenceTranslation, type CallToolResult } from "@soulstream/mcp-contract";
import type { McpRuntime } from "./runtime.js";
import { errorResult } from "./result.js";
import { runIsolationToolGuard } from "./isolation_tool_guards.js";
import type {
  IsolationPolicy,
  McpPrincipal,
} from "../security/session_isolation_contract.js";

const CONFIG_MUTATION_TOOL_NAMES = new Set([
  "update_agent_profile",
  "set_agent_mcp_profile",
  "rollback_agents_config",
  "apply_remote_agent_profile_update",
  "rollback_remote_agents_config",
  "set_agent_atom_contexts",
  "set_folder_system_prompt",
]);
const REGISTERED_TOOL_NAMES_BY_RUNTIME = new WeakMap<McpRuntime, Set<string>>();

/**
 * MCP 서버 생성 시점의 도구 거름.
 *
 * - restricted 요청은 격리 정책(policy)으로 거른다.
 * - 세션 ID가 있는 요청(ssf1/ssr1)은 그 세션 프로필의 `disallowedTools`도 함께 거른다.
 * - 세션 ID 없는 서비스 토큰 요청은 거름이 없다.
 */
export interface McpToolAccess {
  principal: McpPrincipal;
  /** restricted principal의 격리 도구 정책. full principal에는 없다. */
  policy?: IsolationPolicy;
  /** 세션 프로필이 금지한 소울스트림 도구의 맨 이름. */
  disallowedTools?: ReadonlySet<string>;
}

export function createInventoryMcpServer(
  server: McpServer,
  runtime: McpRuntime,
  access?: McpToolAccess,
): McpServer {
  const restrictedAccess = restrictedPolicyAccess(access);
  return new Proxy(server, { get(target, prop, receiver) {
    if (prop !== "registerTool") return Reflect.get(target, prop, receiver);
    return (name: string, config: unknown, handler: (...args: unknown[]) => unknown) => {
      const destructive = isDestructiveMcpTool(name, config);
      const registeredConfig = destructive ? withDestructiveHint(config) : config;
      const restricted = restrictedAccess
        ? restrictedToolHandler(restrictedAccess, runtime, name, config, handler)
        : handler;
      const registered = target.registerTool(name, registeredConfig as never, translateCardReferences(runtime, config, restricted, destructive) as never);
      recordRegisteredTool(runtime, name);
      if (access && !isToolAllowed(access, name)) {
        registered.disable();
      }
      return registered;
    };
  } }) as McpServer;
}

type RestrictedPolicyAccess = McpToolAccess & {
  principal: Extract<McpPrincipal, { tier: "restricted" }>;
  policy: IsolationPolicy;
};

/** restricted principal과 정책이 함께 있을 때만 handler 앞에 정책 거름을 세운다. */
function restrictedPolicyAccess(access: McpToolAccess | undefined): RestrictedPolicyAccess | undefined {
  if (!access || access.principal.tier !== "restricted" || !access.policy) return undefined;
  return { ...access, principal: access.principal, policy: access.policy };
}

/** 세션 프로필 금지 도구와 restricted 정책을 모두 통과해야 도구가 남는다. */
function isToolAllowed(access: McpToolAccess, toolName: string): boolean {
  if (access.disallowedTools?.has(toolName)) return false;
  if (access.policy) return isAllowedForRestricted(access.policy, toolName);
  return true;
}

/**
 * restricted 도구 정책(§4).
 *
 * - deny와 미분류 도구는 `RegisteredTool.disable()`로 tools/list에서 빠지고
 *   tools/call은 handler 전에 거부된다.
 * - guarded/inherit는 handler 전에 guard를 실행한다.
 * - caller_session_id를 선언한 도구는 인증된 restricted 세션으로 강제한다.
 */
function restrictedToolHandler(
  access: RestrictedPolicyAccess,
  runtime: McpRuntime,
  name: string,
  config: unknown,
  handler: (...args: unknown[]) => unknown,
): (...args: unknown[]) => unknown {
  const entry = access.policy.tools[name];
  const declaresCaller = declaresCallerSessionId(config);
  const guarded = entry?.category === "guarded" || entry?.category === "inherit";
  if (!declaresCaller && !guarded) return handler;

  return async (args: unknown, extra: unknown) => {
    const normalized: Record<string, unknown> = isRecord(args) ? { ...args } : {};
    if (declaresCaller) normalized.caller_session_id = access.principal.sessionId;
    if (entry?.category === "guarded" || entry?.category === "inherit") {
      const decision = await runIsolationToolGuard(entry.guard, normalized, {
        runtime,
        principal: access.principal,
      });
      if (!decision.ok) {
        return errorResult(decision.message, { code: "MCP_POLICY_DENIED" });
      }
      Object.assign(normalized, decision.args);
    }
    return await handler(normalized, extra);
  };
}

function isAllowedForRestricted(policy: IsolationPolicy, toolName: string): boolean {
  const entry = policy.tools[toolName];
  return entry !== undefined && entry.category !== "deny";
}

function declaresCallerSessionId(config: unknown): boolean {
  if (!isRecord(config) || !isRecord(config.inputSchema)) return false;
  return Object.prototype.hasOwnProperty.call(config.inputSchema, "caller_session_id");
}

/**
 * Every worker tool call passes here, so this is the one place `#412` / `#412.s2` become full IDs:
 * handlers below never see a number reference. The SDK calls a handler as `(args, extra)` only when
 * the tool has an inputSchema and as `(extra)` otherwise, so a tool without one is left alone.
 */
function translateCardReferences(
  runtime: McpRuntime,
  config: unknown,
  handler: (...args: unknown[]) => unknown,
  destructive: boolean,
): (...args: unknown[]) => unknown {
  if (!isRecord(config) || !config.inputSchema) return handler;
  return (args: unknown, extra: unknown) => callWithReferenceTranslation(
    args as Record<string, unknown>,
    refs => runtime.db.resolveCardReferences(refs),
    translated => handler(translated, extra) as Promise<CallToolResult>,
    { rejectReferences: destructive },
  );
}

export function getRegisteredMcpToolNames(runtime: McpRuntime): string[] {
  return [...(REGISTERED_TOOL_NAMES_BY_RUNTIME.get(runtime) ?? [])].sort();
}

function isDestructiveMcpTool(
  toolName: string,
  config?: unknown,
): boolean {
  if (CONFIG_MUTATION_TOOL_NAMES.has(toolName)) return true;
  const explicitHint = readDestructiveHint(config);
  return explicitHint ?? toolName.startsWith("delete_");
}

function recordRegisteredTool(runtime: McpRuntime, toolName: string): void {
  let names = REGISTERED_TOOL_NAMES_BY_RUNTIME.get(runtime);
  if (!names) {
    names = new Set();
    REGISTERED_TOOL_NAMES_BY_RUNTIME.set(runtime, names);
  }
  names.add(toolName);
}

function withDestructiveHint(config: unknown): unknown {
  if (!isRecord(config)) return config;
  const annotations = isRecord(config.annotations) ? config.annotations : {};
  if (typeof annotations.destructiveHint === "boolean") return config;
  return {
    ...config,
    annotations: {
      ...annotations,
      destructiveHint: true,
    },
  };
}

function readDestructiveHint(config: unknown): boolean | undefined {
  if (!isRecord(config) || !isRecord(config.annotations)) return undefined;
  return typeof config.annotations.destructiveHint === "boolean"
    ? config.annotations.destructiveHint
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
