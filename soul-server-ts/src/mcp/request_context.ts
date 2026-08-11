import { AsyncLocalStorage } from "node:async_hooks";

export const SOULSTREAM_AGENT_SESSION_HEADER = "x-soulstream-agent-session-id";
export const SOULSTREAM_CALLER_ORIGIN_HEADER = "x-soulstream-caller-origin";

export type McpCallerOrigin = "llm" | "internal";

export interface McpRequestContext {
  callerSessionId?: string;
  callerOrigin?: McpCallerOrigin;
}

const storage = new AsyncLocalStorage<McpRequestContext>();

export function withMcpRequestContext<T>(
  context: McpRequestContext,
  fn: () => T,
): T {
  const callerSessionId = cleanSessionId(context.callerSessionId);
  const callerOrigin = context.callerOrigin;
  return storage.run(
    {
      ...(callerSessionId ? { callerSessionId } : {}),
      ...(callerOrigin ? { callerOrigin } : {}),
    },
    fn,
  );
}

export function getCurrentMcpCallerSessionId(): string | undefined {
  return cleanSessionId(storage.getStore()?.callerSessionId);
}

export function getCurrentMcpCallerOrigin(): McpCallerOrigin | undefined {
  return storage.getStore()?.callerOrigin;
}

function cleanSessionId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
