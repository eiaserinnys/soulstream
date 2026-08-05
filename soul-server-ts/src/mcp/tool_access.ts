import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { getCurrentMcpCallerOrigin } from "./request_context.js";
import { errorResult } from "./result.js";
import type { McpRuntime } from "./runtime.js";

const DESTRUCTIVE_OPERATIONS_BY_TOOL: Readonly<
  Record<string, ReadonlySet<string>>
> = {
  batch_page_operations: new Set(["delete_block_subtree"]),
};
const DESTRUCTIVE_TOOL_NAMES_BY_RUNTIME = new WeakMap<
  McpRuntime,
  Set<string>
>();

export function isDestructiveMcpTool(
  toolName: string,
  config?: unknown,
): boolean {
  const explicitHint = readDestructiveHint(config);
  return explicitHint ?? toolName.startsWith("delete_");
}

function hasDestructiveOperation(
  toolName: string,
  args: unknown,
): boolean {
  const destructiveOperations = DESTRUCTIVE_OPERATIONS_BY_TOOL[toolName];
  if (!destructiveOperations || !isRecord(args)) return false;
  return Array.isArray(args.operations)
    && args.operations.some(
      (operation) =>
        isRecord(operation)
        && typeof operation.op === "string"
        && destructiveOperations.has(operation.op),
    );
}

export function guardMcpToolCallRequest(
  runtime: McpRuntime,
  body: unknown,
): CallToolResult | undefined {
  if (getCurrentMcpCallerOrigin() !== "llm" || !isRecord(body)) {
    return undefined;
  }
  if (body.method !== "tools/call" || !isRecord(body.params)) {
    return undefined;
  }
  const toolName = body.params.name;
  if (typeof toolName !== "string") return undefined;
  return guardExternalLlmDestructiveOperation(
    runtime,
    toolName,
    body.params.arguments,
  );
}

export function guardMcpToolExecution(
  runtime: McpRuntime,
  toolName: string,
  args?: unknown,
  config?: unknown,
): CallToolResult | undefined {
  if (getCurrentMcpCallerOrigin() === "llm") {
    const blocked = guardExternalLlmDestructiveOperation(
      runtime,
      toolName,
      args,
      config,
    );
    if (blocked) return blocked;
  }
  return undefined;
}

export function createGuardedMcpServer(
  server: McpServer,
  runtime: McpRuntime,
): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== "registerTool") {
        return Reflect.get(target, prop, receiver);
      }
      return (name: string, config: unknown, handler: (...args: unknown[]) => unknown) => {
        const staticallyDestructive = isDestructiveMcpTool(name, config);
        recordDestructiveTool(runtime, name, staticallyDestructive);
        if (
          getCurrentMcpCallerOrigin() === "llm"
          && staticallyDestructive
        ) {
          return undefined;
        }
        const registeredConfig = staticallyDestructive
          ? withDestructiveHint(config)
          : config;
        const wrappedHandler = async (...args: unknown[]) => {
          const blocked = guardMcpToolExecution(
            runtime,
            name,
            args[0],
            registeredConfig,
          );
          if (blocked) return blocked;
          return await handler(...args);
        };
        const registerTool = Reflect.get(target, prop, target) as (
          toolName: string,
          toolConfig: unknown,
          toolHandler: (...args: unknown[]) => unknown,
        ) => unknown;
        return registerTool.call(target, name, registeredConfig, wrappedHandler);
      };
    },
  }) as McpServer;
}

function guardExternalLlmDestructiveOperation(
  runtime: McpRuntime,
  toolName: string,
  args: unknown,
  config?: unknown,
): CallToolResult | undefined {
  const destructiveNames = DESTRUCTIVE_TOOL_NAMES_BY_RUNTIME.get(runtime);
  const staticallyDestructive = config === undefined
    ? destructiveNames?.has(toolName) ?? isDestructiveMcpTool(toolName)
    : isDestructiveMcpTool(toolName, config);
  if (!staticallyDestructive && !hasDestructiveOperation(toolName, args)) {
    return undefined;
  }
  runtime.logger?.warn(
    { callerOrigin: "llm", toolName },
    "Blocked destructive MCP tool for external LLM caller",
  );
  return errorResult(
    `MCP tool "${toolName}" is not available to external LLM callers`,
  );
}

function recordDestructiveTool(
  runtime: McpRuntime,
  toolName: string,
  destructive: boolean,
): void {
  let names = DESTRUCTIVE_TOOL_NAMES_BY_RUNTIME.get(runtime);
  if (!names) {
    names = new Set();
    DESTRUCTIVE_TOOL_NAMES_BY_RUNTIME.set(runtime, names);
  }
  if (destructive) {
    names.add(toolName);
  } else {
    names.delete(toolName);
  }
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
