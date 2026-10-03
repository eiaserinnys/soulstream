import {
  getCurrentMcpCallerSessionId,
  SOULSTREAM_AGENT_SESSION_HEADER,
} from "../request_context.js";
import {
  buildCallerInfoFromCallerSession,
} from "../../caller_info.js";
import type { CallerInfo } from "../../task/task_models.js";
import type { McpRuntime } from "../runtime.js";

export const MISSING_REMOTE_CALLER_SESSION_ID_ERROR = [
  "caller_session_id is required for create_remote_agent_session.",
  `Pass the current soulstream_session.agent_session_id or send ${SOULSTREAM_AGENT_SESSION_HEADER}.`,
].join(" ");

export { CALLER_SESSION_ID_FALLBACK_GUIDANCE } from "@soulstream/mcp-contract";

export function resolveEffectiveCallerSessionId(
  explicitCallerSessionId: string | null | undefined,
): string | undefined {
  return resolveMcpCallerIdentity(explicitCallerSessionId).callerSessionId;
}

export interface McpCallerAttribution {
  callerSessionId: string | undefined;
  callerInfo: CallerInfo | undefined;
}

export type McpMutationActor = { actorKind: "agent"; actorSessionId: string };

function resolveMcpCallerIdentity(
  explicitCallerSessionId: string | null | undefined,
): { callerSessionId: string | undefined } {
  return {
    callerSessionId:
      cleanSessionId(explicitCallerSessionId) ?? getCurrentMcpCallerSessionId(),
  };
}

export function resolveMcpCallerAttribution(
  runtime: McpRuntime,
  explicitCallerSessionId: string | null | undefined,
): McpCallerAttribution {
  const identity = resolveMcpCallerIdentity(explicitCallerSessionId);
  const { callerSessionId } = identity;
  return {
    callerSessionId,
    callerInfo: callerSessionId
      ? buildCallerInfoFromCallerSession(runtime, callerSessionId)
      : undefined,
  };
}

export function resolveMcpMutationActor(
  explicitCallerSessionId: string | null | undefined,
): McpMutationActor | undefined {
  const identity = resolveMcpCallerIdentity(explicitCallerSessionId);
  const actorSessionId = identity.callerSessionId;
  return actorSessionId
    ? { actorKind: "agent", actorSessionId }
    : undefined;
}

export function requireMcpMutationActor(
  explicitCallerSessionId: string | null | undefined,
  operation: string,
): McpMutationActor {
  const actor = resolveMcpMutationActor(explicitCallerSessionId);
  if (actor) return actor;
  throw new Error(
    `caller session id is required for ${operation}. Send ${SOULSTREAM_AGENT_SESSION_HEADER}.`,
  );
}

export function requireRemoteCallerAttribution(
  runtime: McpRuntime,
  explicitCallerSessionId: string | null | undefined,
):
  | ({ ok: true } & McpCallerAttribution)
  | { ok: false; error: string } {
  const attribution = resolveMcpCallerAttribution(
    runtime,
    explicitCallerSessionId,
  );
  if (!attribution.callerSessionId) {
    return { ok: false, error: MISSING_REMOTE_CALLER_SESSION_ID_ERROR };
  }
  return { ok: true, ...attribution };
}

function cleanSessionId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
