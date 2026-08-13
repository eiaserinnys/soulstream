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

/**
 * What the relayed intervention actually achieved, as reported by the owning
 * node through the orchestrator.
 *
 * `delivered: null` is not "undelivered" — it means the orchestrator returned
 * no verdict, so we genuinely do not know. Callers that treat unknown as
 * failure will retry an intervention the agent already consumed; callers that
 * treat it as success will lose one silently. The distinction has to survive.
 */
export type RelayedInterventionVerdict = {
  delivered: boolean | null;
  outcome: string | null;
  reason: string | null;
  consume_when: string | null;
  queue_position: number | null;
};

export type SendMessageToSessionResult =
  | { ok: true; detail: AddInterventionResult }
  | {
      ok: true;
      detail: {
        relayed: true;
        target_session_id: string;
        local_error: string | null;
      } & RelayedInterventionVerdict;
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
    const verdict = await relayMessageToOrch(
      orch,
      params.targetSessionId,
      params.message,
      params.callerInfo,
      deps.fetchImpl,
    );
    if (verdict.delivered === null) {
      deps.logger.warn(
        { targetSessionId: params.targetSessionId, reason: verdict.reason },
        "send_message_to_session relayed without a delivery verdict",
      );
    }
    return {
      ok: true,
      detail: {
        relayed: true,
        target_session_id: params.targetSessionId,
        local_error: localError,
        ...verdict,
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
): Promise<RelayedInterventionVerdict> {
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
  return parseInterveneVerdict(await readJsonBody(resp));
}

async function readJsonBody(resp: Response): Promise<unknown> {
  try {
    return await resp.json();
  } catch {
    // A 2xx with an unreadable body still delivered the command to orch; the
    // verdict is what we lost, and `delivered: null` says exactly that.
    return null;
  }
}

/**
 * The owning node answers `intervene` with an `intervene_ack`, and orch passes
 * that node response through as the HTTP body. Read the verdict out of it
 * rather than inventing one.
 */
function parseInterveneVerdict(body: unknown): RelayedInterventionVerdict {
  const unknownVerdict: RelayedInterventionVerdict = {
    delivered: null,
    outcome: null,
    reason: "orch returned no intervene verdict",
    consume_when: null,
    queue_position: null,
  };
  if (!isRecord(body)) return unknownVerdict;
  if (typeof body.delivered !== "boolean") return unknownVerdict;

  return {
    delivered: body.delivered,
    outcome: stringOrNull(body.outcome),
    reason: stringOrNull(body.reason),
    consume_when: stringOrNull(body.consumeWhen ?? body.consume_when),
    queue_position: typeof body.queuePosition === "number"
      ? body.queuePosition
      : typeof body.queue_position === "number" ? body.queue_position : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
