import type { Logger } from "pino";

import {
  ensureHumanDeliveryIdentity,
  type AddInterventionParams,
} from "./task_intervention_route.js";
import { TaskOwnedByAnotherNodeError } from "./task_hydration_errors.js";
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
  nodeId: string;
  sessionLookup: {
    getSession(sessionId: string): Promise<{ node_id: string | null } | null>;
  };
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
  const request = ensureHumanDeliveryIdentity({
    agentSessionId: params.targetSessionId,
    text: params.message,
    user: "agent",
    callerInfo: params.callerInfo,
  });

  let ownerNodeId: string | null;
  try {
    ownerNodeId = await resolveOwnerNodeId(deps, params.targetSessionId);
  } catch (err) {
    const error = errorMessage(err);
    return {
      ok: false,
      error,
      fallback_error: `target owner lookup failed: ${error}`,
    };
  }
  if (ownerNodeId !== null && ownerNodeId !== deps.nodeId) {
    return await relayThroughOrch(deps, request, null);
  }

  let localError: string | null = null;
  try {
    const detail = await deps.taskManager.addIntervention(
      request,
      deps.onResume,
    );
    return { ok: true, detail };
  } catch (err) {
    localError = err instanceof Error ? err.message : String(err);
    deps.logger.warn(
      { err, targetSessionId: params.targetSessionId },
      "send_message_to_session local delivery failed — trying orch fallback",
    );
    if (err instanceof TaskOwnedByAnotherNodeError) {
      try {
        const ownerNodeId = await resolveOwnerNodeId(deps, params.targetSessionId);
        if (ownerNodeId === null || ownerNodeId === deps.nodeId) {
          return {
            ok: false,
            error: localError,
            fallback_error: "target owner remained local after NOT_OWNER",
          };
        }
      } catch (ownerError) {
        return {
          ok: false,
          error: localError,
          fallback_error: `target owner relookup failed: ${errorMessage(ownerError)}`,
        };
      }
    }
  }

  return await relayThroughOrch(deps, request, localError);
}

async function resolveOwnerNodeId(
  deps: Pick<SendMessageToSessionDeps, "sessionLookup">,
  targetSessionId: string,
): Promise<string | null> {
  const session = await deps.sessionLookup.getSession(targetSessionId);
  return session?.node_id ?? null;
}

async function relayThroughOrch(
  deps: SendMessageToSessionDeps,
  request: AddInterventionParams,
  localError: string | null,
): Promise<SendMessageToSessionResult> {
  const orch = deps.orch;
  if (!orch) {
    return {
      ok: false,
      error: localError,
      fallback_error: "orch fallback unavailable",
    };
  }

  let fallbackError = "orch relay failed";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const verdict = await relayMessageToOrch(
        orch,
        request,
        deps.fetchImpl,
      );
      if (verdict.delivered === null) {
        deps.logger.warn(
          { targetSessionId: request.agentSessionId, reason: verdict.reason },
          "send_message_to_session relayed without a delivery verdict",
        );
      }
      return {
        ok: true,
        detail: {
          relayed: true,
          target_session_id: request.agentSessionId,
          local_error: localError,
          ...verdict,
        },
      };
    } catch (err) {
      fallbackError = errorMessage(err);
      if (attempt === 2 || !isRetryableRelayError(err)) break;
      deps.logger.warn(
        {
          err,
          targetSessionId: request.agentSessionId,
          deliveryId: request.deliveryId,
        },
        "send_message_to_session relay failed — retrying same delivery identity",
      );
    }
  }
  return {
    ok: false,
    error: localError,
    fallback_error: fallbackError,
  };
}

async function relayMessageToOrch(
  orch: SessionMessageOrchConfig,
  request: AddInterventionParams,
  fetchImpl: typeof fetch = fetch,
): Promise<RelayedInterventionVerdict> {
  const url = `${orch.baseUrl}/api/sessions/${request.agentSessionId}/intervene`;
  const body: Record<string, unknown> = {
    text: request.text,
    user: request.user,
    delivery_id: request.deliveryId,
    delivery_intent: request.deliveryIntent,
    source: request.source,
    completion_id: request.completionId,
    relation_key: request.relationKey,
    created_at: request.deliveryCreatedAt,
  };
  if (request.callerInfo !== undefined) {
    body.caller_info = request.callerInfo;
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
    throw new RelayResponseError(
      resp.status,
      `orch POST /api/sessions/${request.agentSessionId}/intervene failed: ${resp.status} ${resp.statusText}`,
    );
  }
  return parseInterveneVerdict(await readJsonBody(resp));
}

class RelayResponseError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "RelayResponseError";
  }
}

function isRetryableRelayError(error: unknown): boolean {
  return !(error instanceof RelayResponseError) || error.status >= 500;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  if (body.delivered !== null && typeof body.delivered !== "boolean") {
    return unknownVerdict;
  }

  return {
    delivered: body.delivered,
    outcome: stringOrNull(body.outcome),
    reason: stringOrNull(body.reason) ?? (
      body.delivered === null ? unknownVerdict.reason : null
    ),
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
