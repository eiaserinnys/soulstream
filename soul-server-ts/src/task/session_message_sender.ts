import type { Logger } from "pino";

import type { CallerInfo } from "./task_models.js";
import type {
  AddInterventionResult,
  StartExecutionCallback,
  TaskManager,
} from "./task_manager.js";

export interface SessionMessageOrchConfig {
  baseUrl: string;
  headers: Record<string, string>;
}

export interface SendMessageToSessionDeps {
  taskManager: Pick<TaskManager, "addIntervention">;
  onResume: StartExecutionCallback;
  logger: Logger;
  orch?: SessionMessageOrchConfig;
  fetchImpl?: typeof fetch;
}

export interface SendMessageToSessionParams {
  targetSessionId: string;
  message: string;
  callerInfo?: CallerInfo;
}

export type SendMessageToSessionResult =
  | { ok: true; detail: AddInterventionResult }
  | {
      ok: true;
      detail: {
        relayed: true;
        target_session_id: string;
        local_error: string | null;
      };
    }
  | {
      ok: false;
      error: string | null;
      fallback_error: string;
    };

export async function sendMessageToSession(
  deps: SendMessageToSessionDeps,
  params: SendMessageToSessionParams,
): Promise<SendMessageToSessionResult> {
  let localError: string | null = null;
  try {
    const detail = await deps.taskManager.addIntervention(
      {
        agentSessionId: params.targetSessionId,
        text: params.message,
        user: "agent",
        callerInfo: params.callerInfo,
      },
      deps.onResume,
    );
    return { ok: true, detail };
  } catch (err) {
    localError = err instanceof Error ? err.message : String(err);
    deps.logger.warn(
      { err, targetSessionId: params.targetSessionId },
      "send_message_to_session local delivery failed — trying orch fallback",
    );
  }

  const orch = deps.orch;
  if (!orch) {
    return {
      ok: false,
      error: localError,
      fallback_error: "orch fallback unavailable",
    };
  }

  try {
    await relayMessageToOrch(
      orch,
      params.targetSessionId,
      params.message,
      params.callerInfo,
      deps.fetchImpl,
    );
    return {
      ok: true,
      detail: {
        relayed: true,
        target_session_id: params.targetSessionId,
        local_error: localError,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: localError,
      fallback_error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function relayMessageToOrch(
  orch: SessionMessageOrchConfig,
  targetSessionId: string,
  message: string,
  callerInfo: CallerInfo | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = `${orch.baseUrl}/api/sessions/${targetSessionId}/intervene`;
  const body: Record<string, unknown> = {
    text: message,
    user: "agent",
  };
  if (callerInfo !== undefined) {
    // orch InterveneRequest의 Pydantic 필드명은 snake_case. camelCase callerInfo 금지.
    body.caller_info = callerInfo;
  }

  const resp = await fetchImpl(url, {
    method: "POST",
    headers: {
      ...orch.headers,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(
      `orch POST /api/sessions/${targetSessionId}/intervene failed: ${resp.status} ${resp.statusText}`,
    );
  }
}
