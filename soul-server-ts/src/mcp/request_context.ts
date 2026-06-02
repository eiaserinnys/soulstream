import { AsyncLocalStorage } from "node:async_hooks";

export const SOULSTREAM_AGENT_SESSION_HEADER = "x-soulstream-agent-session-id";

export interface McpRequestContext {
  callerSessionId?: string;
}

const storage = new AsyncLocalStorage<McpRequestContext>();

export function withMcpRequestContext<T>(
  context: McpRequestContext,
  fn: () => T,
): T {
  const callerSessionId = cleanSessionId(context.callerSessionId);
  return storage.run(
    callerSessionId ? { callerSessionId } : {},
    fn,
  );
}

export function getCurrentMcpCallerSessionId(): string | undefined {
  return cleanSessionId(storage.getStore()?.callerSessionId);
}

function cleanSessionId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
