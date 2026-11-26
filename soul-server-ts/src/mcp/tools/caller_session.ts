import {
  buildCallerInfoFromCallerSession,
} from "../../caller_info.js";
import type { CallerInfo } from "../../task/task_models.js";
import {
  getCurrentMcpCallerSessionId,
  getCurrentMcpPrincipal,

} from "../request_context.js";
import type { McpRuntime } from "../runtime.js";


export function resolveEffectiveCallerSessionId(
  explicitCallerSessionId: string | null | undefined,
): string | undefined {
  const principal = getCurrentMcpPrincipal();
  if (principal.tier === "restricted") return principal.sessionId;
  return cleanSessionId(explicitCallerSessionId) ?? getCurrentMcpCallerSessionId();
}

interface McpCallerAttribution {
  callerSessionId: string | undefined;
  callerInfo: CallerInfo | undefined;
}

type McpMutationActor = { actorKind: "agent"; actorSessionId: string };

export function resolveMcpCallerAttribution(
  runtime: McpRuntime,
  explicitCallerSessionId: string | null | undefined,
): McpCallerAttribution {
  const callerSessionId = resolveEffectiveCallerSessionId(explicitCallerSessionId);
  return {
    callerSessionId,
    callerInfo: callerSessionId
      ? buildCallerInfoFromCallerSession(runtime, callerSessionId)
      : undefined,
  };
}

function resolveMcpMutationActor(
  explicitCallerSessionId: string | null | undefined,
): McpMutationActor | undefined {
  const actorSessionId = resolveEffectiveCallerSessionId(explicitCallerSessionId);
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
    `${operation}에는 caller_session_id가 필요합니다. 현재 세션의 soulstream_session.agent_session_id 값을 넘기세요.`,
  );
}

function cleanSessionId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
