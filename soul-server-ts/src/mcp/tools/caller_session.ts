import {
  getCurrentMcpCallerPrincipal,
  getCurrentMcpCallerSessionId,
  isCurrentMcpCallerExternal,
  SOULSTREAM_AGENT_SESSION_HEADER,
} from "../request_context.js";
import {
  buildCallerInfoFromCallerSession,
  buildExternalMcpCallerInfo,
} from "../../caller_info.js";
import type { CallerInfo } from "../../task/task_models.js";
import type { McpRuntime } from "../runtime.js";

export const MISSING_REMOTE_CALLER_SESSION_ID_ERROR = [
  "caller_session_id is required for create_remote_agent_session.",
  `Pass the current soulstream_session.agent_session_id or send ${SOULSTREAM_AGENT_SESSION_HEADER}.`,
].join(" ");

export const CALLER_SESSION_ID_FALLBACK_GUIDANCE =
  "세션 헤더를 전달할 수 없는 신뢰된 내부 클라이언트만 자기 agent_session_id를 caller_session_id로 전달한다.";

export function resolveEffectiveCallerSessionId(
  explicitCallerSessionId: string | null | undefined,
): string | undefined {
  return resolveMcpCallerIdentity(explicitCallerSessionId).callerSessionId;
}

export interface McpCallerAttribution {
  callerSessionId: string | undefined;
  callerInfo: CallerInfo | undefined;
}

export type McpMutationActor =
  | { actorKind: "agent"; actorSessionId: string }
  | { actorKind: "llm"; actorSessionId: null };

type McpCallerIdentity =
  | { authority: "external"; callerSessionId: undefined }
  | { authority: "internal"; callerSessionId: string | undefined };

function resolveMcpCallerIdentity(
  explicitCallerSessionId: string | null | undefined,
): McpCallerIdentity {
  if (isCurrentMcpCallerExternal()) {
    return { authority: "external", callerSessionId: undefined };
  }
  return {
    authority: "internal",
    callerSessionId:
      cleanSessionId(explicitCallerSessionId) ?? getCurrentMcpCallerSessionId(),
  };
}

export function resolveMcpCallerAttribution(
  runtime: McpRuntime,
  explicitCallerSessionId: string | null | undefined,
): McpCallerAttribution {
  const identity = resolveMcpCallerIdentity(explicitCallerSessionId);
  if (identity.authority === "external") {
    const principal = getCurrentMcpCallerPrincipal();
    return {
      callerSessionId: undefined,
      callerInfo: buildExternalMcpCallerInfo(
        runtime.nodeId,
        principal?.source ?? "llm",
        principal?.displayName ?? "External LLM",
      ),
    };
  }
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
  if (identity.authority === "external") {
    return { actorKind: "llm", actorSessionId: null };
  }
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
  if (isCurrentMcpCallerExternal()) {
    return { ok: true, ...attribution };
  }
  if (!attribution.callerSessionId) {
    return { ok: false, error: MISSING_REMOTE_CALLER_SESSION_ID_ERROR };
  }
  return { ok: true, ...attribution };
}

function cleanSessionId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
