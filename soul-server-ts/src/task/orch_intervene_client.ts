import type { OrchProxyConfig } from "../mcp/runtime.js";
import {
  fetchOrchResponse,
  ORCH_HOST_REQUEST_TIMEOUT_MS,
} from "../control_plane/persistence_host_transport.js";

import {
  classifyCompletionDeliveryAck,
  type CompletionDeliveryVerdict,
} from "./completion_delivery_verdict.js";
import type { AddInterventionParams } from "./task_intervention_route.js";

export interface OrchInterveneAck {
  verdict: CompletionDeliveryVerdict;
  delivered: boolean | null;
  outcome: string | null;
  reason: string | null;
  consumeWhen: string | null;
  queuePosition: number | null;
}

export class OrchInterveneRequestError extends Error {
  constructor(
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(`orch intervene request failed with HTTP ${status}`);
    this.name = "OrchInterveneRequestError";
  }
}

/** Shared timeout, payload, and ACK interpretation for orch intervention relays. */
export class OrchInterveneClient {
  constructor(
    private readonly orch: Pick<OrchProxyConfig, "baseUrl" | "headers">,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  async send(params: AddInterventionParams): Promise<OrchInterveneAck> {
    const response = await fetchOrchResponse(
      this.orch,
      "POST",
      `/api/sessions/${params.agentSessionId}/intervene`,
      buildBody(params),
      {
        timeoutMs: ORCH_HOST_REQUEST_TIMEOUT_MS,
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      },
    );
    if (!response.ok) {
      throw new OrchInterveneRequestError(response.status, await safeReadText(response));
    }
    let body: unknown;
    try {
      body = await response.json() as unknown;
    } catch {
      body = null;
    }
    const record = isRecord(body) ? body : {};
    return {
      verdict: classifyCompletionDeliveryAck(body),
      delivered: typeof record.delivered === "boolean" || record.delivered === null
        ? record.delivered
        : null,
      outcome: stringOrNull(record.outcome),
      reason: stringOrNull(record.reason),
      consumeWhen: stringOrNull(record.consumeWhen ?? record.consume_when),
      queuePosition: typeof record.queuePosition === "number"
        ? record.queuePosition
        : typeof record.queue_position === "number" ? record.queue_position : null,
    };
  }
}

function buildBody(params: AddInterventionParams): Record<string, unknown> {
  return {
    text: params.text,
    user: params.user,
    ...(params.callerInfo !== undefined ? { caller_info: params.callerInfo } : {}),
    ...(params.rateLimitType !== undefined ? { rate_limit_type: params.rateLimitType } : {}),
    ...(params.resetsAt !== undefined ? { resets_at: params.resetsAt } : {}),
    ...(params.deliveryId
      ? {
          delivery_id: params.deliveryId,
          delivery_intent: params.deliveryIntent,
          source: params.source,
          completion_id: params.completionId,
          relation_key: params.relationKey,
          producer_terminal_revision: params.producerTerminalRevision,
          parent_delivery_id: params.parentDeliveryId,
          caller_turn_id: params.callerTurnId,
          created_at: params.deliveryCreatedAt,
          delivery_attempt_token: params.deliveryAttemptToken,
        }
      : {}),
  };
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
