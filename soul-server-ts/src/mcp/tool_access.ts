import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { callWithReferenceTranslation, type CallToolResult } from "@soulstream/mcp-contract";
import type { McpRuntime } from "./runtime.js";

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

export function createInventoryMcpServer(server: McpServer, runtime: McpRuntime): McpServer {
  return new Proxy(server, { get(target, prop, receiver) {
    if (prop !== "registerTool") return Reflect.get(target, prop, receiver);
    return (name: string, config: unknown, handler: (...args: unknown[]) => unknown) => {
      const destructive = isDestructiveMcpTool(name, config);
      const registeredConfig = destructive ? withDestructiveHint(config) : config;
      const registered = target.registerTool(name, registeredConfig as never, translateCardReferences(runtime, config, handler, destructive) as never);
      recordRegisteredTool(runtime, name);
      return registered;
    };
  } }) as McpServer;
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
