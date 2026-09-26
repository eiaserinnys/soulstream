import type { Logger } from "pino";

import {
  ensureHumanDeliveryIdentity,
  type AddInterventionParams,
} from "./task_intervention_route.js";
import { OrchInterveneClient, OrchInterveneRequestError } from "./orch_intervene_client.js";
import { TaskOwnedByAnotherNodeError } from "./task_hydration_errors.js";
import type { DeliveryIntent } from "./delivery_contract.js";
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
  deliveryId?: string;
  deliveryIntent?: DeliveryIntent;
  source?: string;
  completionId?: string;
  relationKey?: string;
  producerTerminalRevision?: string;
  parentDeliveryId?: string;
  callerTurnId?: string;
  deliveryCreatedAt?: string;
  deliveryAttemptToken?: string;
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
  const {
    targetSessionId,
    message,
    callerInfo,
    ...deliveryMetadata
  } = params;
  const request = ensureHumanDeliveryIdentity({
    agentSessionId: targetSessionId,
    text: message,
    user: "agent",
    callerInfo,
    ...deliveryMetadata,
  });

  let ownerNodeId: string | null;
  try {
    ownerNodeId = await resolveOwnerNodeId(deps, targetSessionId);
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
      { err, targetSessionId },
      "send_message_to_session local delivery failed",
    );
    if (err instanceof TaskOwnedByAnotherNodeError) {
      try {
        const ownerNodeId = await resolveOwnerNodeId(deps, targetSessionId);
        if (ownerNodeId === null || ownerNodeId === deps.nodeId) {
          return {
            ok: false,
            error: localError,
            fallback_error: "target owner remained local after NOT_OWNER",
          };
        }
        return await relayThroughOrch(deps, request, localError);
      } catch (ownerError) {
        return {
          ok: false,
          error: localError,
          fallback_error: `target owner relookup failed: ${errorMessage(ownerError)}`,
        };
      }
    }
    return {
      ok: false,
      error: localError,
      fallback_error: "orch relay is reserved for a confirmed remote owner",
    };
  }

  return { ok: false, error: localError, fallback_error: "local delivery failed" };
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
  const client = new OrchInterveneClient(orch, deps.fetchImpl);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const ack = await client.send(request);
      if (ack.verdict.kind === "unknown") {
        deps.logger.warn(
          { targetSessionId: request.agentSessionId, reason: ack.verdict.reason },
          "send_message_to_session relayed without a delivery verdict",
        );
      }
      return {
        ok: true,
        detail: {
          relayed: true,
          target_session_id: request.agentSessionId,
          local_error: localError,
          delivered: ack.delivered,
          outcome: ack.outcome,
          reason: ack.reason,
          consume_when: ack.consumeWhen,
          queue_position: ack.queuePosition,
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

function isRetryableRelayError(error: unknown): boolean {
  return !(error instanceof OrchInterveneRequestError) || error.status >= 500;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
