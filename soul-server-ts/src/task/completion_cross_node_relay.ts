import type { Logger } from "pino";

import type { CompletionDeliveryVerdict } from "./completion_delivery_verdict.js";
import { OrchInterveneClient, OrchInterveneRequestError } from "./orch_intervene_client.js";
import type { AddInterventionParams } from "./task_manager.js";

/**
 * orch /api/sessions/{caller}/intervene HTTP POST.
 *
 * 키 케이스 *고정* — orch TypeScript `InterveneNodeCommandPayload`
 * (`orch-server-ts/src/session/session_action_command_payloads.ts`) 정합:
 *   - text         : str
 *   - user         : str (=== "agent")
 *   - caller_info  : Optional[dict]   ← snake_case! `callerInfo`(camelCase)는 무시됨.
 *
 * 활성 TypeScript wire 계약과 같은 payload — 양 서버가 같은 키 케이스로 일관 처리하여
 * atom F-11C 회로(cross-node fallback caller_info 누락) 차단.
 *
 * 응답 non-2xx 또는 fetch throw 모두 *child finalize에 throw 전파 금지*.
 */
export async function relayCompletionCrossNode(
  client: OrchInterveneClient | undefined,
  logger: Pick<Logger, "info" | "warn" | "error">,
  params: AddInterventionParams,
  sourceSessionId?: string,
): Promise<CompletionDeliveryVerdict> {
  if (!client) {
    return { kind: "failed", reason: "orch_fallback_unavailable" };
  }
  const callerSessionId = params.agentSessionId;
  try {
    const { verdict } = await client.send(params);
    if (verdict.kind === "accepted") {
      logger.info(
        {
          ...(sourceSessionId ? { childId: sourceSessionId } : {}),
          callerSessionId,
          deliveryId: params.deliveryId,
          disposition: verdict.disposition,
        },
        "Completion notification accepted via cross-node relay",
      );
    } else if (verdict.kind === "settled") {
      logger.info(
        {
          ...(sourceSessionId ? { childId: sourceSessionId } : {}),
          callerSessionId,
          deliveryId: params.deliveryId,
          disposition: verdict.disposition,
        },
        "Completion notification was already settled via cross-node relay",
      );
    } else {
      logger.warn(
        {
          ...(sourceSessionId ? { childId: sourceSessionId } : {}),
          callerSessionId,
          deliveryId: params.deliveryId,
          reason: verdict.reason,
        },
        verdict.kind === "unknown"
          ? "Cross-node completion notification delivery verdict is unknown"
          : "Cross-node completion notification was not accepted",
      );
    }
    return verdict;
  } catch (err) {
    if (err instanceof OrchInterveneRequestError) {
      logger.error(
        {
          ...(sourceSessionId ? { childId: sourceSessionId } : {}),
          callerSessionId,
          status: err.status,
          body: err.responseBody,
        },
        "Cross-node completion notification: orch returned non-2xx",
      );
      return { kind: "failed", reason: `orch_http_${err.status}` };
    }
    logger.error(
      {
        err,
        ...(sourceSessionId ? { childId: sourceSessionId } : {}),
        callerSessionId,
      },
      "Cross-node completion notification failed",
    );
    return { kind: "failed", reason: "cross_node_relay_failed" };
  }
}
