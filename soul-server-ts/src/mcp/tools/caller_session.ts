import {
  getCurrentMcpCallerSessionId,
  SOULSTREAM_AGENT_SESSION_HEADER,
} from "../request_context.js";

export const MISSING_REMOTE_CALLER_SESSION_ID_ERROR = [
  "caller_session_id is required for create_remote_agent_session.",
  `Pass the current soulstream_session.agent_session_id or send ${SOULSTREAM_AGENT_SESSION_HEADER}.`,
].join(" ");

export function resolveEffectiveCallerSessionId(
  explicitCallerSessionId: string | null | undefined,
): string | undefined {
  return cleanSessionId(explicitCallerSessionId) ?? getCurrentMcpCallerSessionId();
}

export function requireRemoteCallerSessionId(
  explicitCallerSessionId: string | null | undefined,
): { ok: true; callerSessionId: string } | { ok: false; error: string } {
  const callerSessionId = resolveEffectiveCallerSessionId(explicitCallerSessionId);
  if (!callerSessionId) {
    return { ok: false, error: MISSING_REMOTE_CALLER_SESSION_ID_ERROR };
  }
  return { ok: true, callerSessionId };
}

function cleanSessionId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
