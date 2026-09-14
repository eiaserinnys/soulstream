import { AsyncLocalStorage } from "node:async_hooks";

export const SOULSTREAM_AGENT_SESSION_HEADER = "x-soulstream-agent-session-id";

export type McpCallerPrincipal =
  | {
      authority: "external";
      source: string;
      displayName: string;
    }
  | {
      authority: "internal";
      source: "internal";
      displayName: "Soulstream internal";
    };

export const GENERIC_EXTERNAL_MCP_PRINCIPAL: McpCallerPrincipal = {
  authority: "external",
  source: "llm",
  displayName: "External LLM",
};

export const INTERNAL_MCP_PRINCIPAL: McpCallerPrincipal = {
  authority: "internal",
  source: "internal",
  displayName: "Soulstream internal",
};

export interface McpRequestContext {
  callerSessionId?: string;
  principal?: McpCallerPrincipal;
}

const storage = new AsyncLocalStorage<McpRequestContext>();

export function withMcpRequestContext<T>(
  context: McpRequestContext,
  fn: () => T,
): T {
  const callerSessionId = cleanSessionId(context.callerSessionId);
  const principal = context.principal;
  return storage.run(
    {
      ...(callerSessionId ? { callerSessionId } : {}),
      ...(principal ? { principal: { ...principal } } : {}),
    },
    fn,
  );
}

export function getCurrentMcpCallerSessionId(): string | undefined {
  return cleanSessionId(storage.getStore()?.callerSessionId);
}

export function getCurrentMcpCallerPrincipal(): McpCallerPrincipal | undefined {
  return storage.getStore()?.principal;
}

export function isCurrentMcpCallerExternal(): boolean {
  return getCurrentMcpCallerPrincipal()?.authority === "external";
}

function cleanSessionId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
