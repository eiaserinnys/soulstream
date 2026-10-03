import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { jsonResult, type sessionMessageTools } from "@soulstream/mcp-contract";
import { SERVICE_CALLER } from "../auth/service_caller.js";
import { executeSessionIntervention } from "../session/session_action_command_routes.js";
import type { McpToolHandler } from "./types.js";

export const sessionMessageHandlers = {
  send_message_to_session: async (options, args, context) => {
    const targetSessionId = String(args.target_session_id);
    const external = context.principal === "external" ? context.externalCaller : undefined;
    const callerInfo = context.callerInfo ?? (external ? {
      source: external.source,
      agent_node: context.nodeId,
      display_name: external.displayName,
      user_id: null,
      avatar_url: null,
    } : undefined);
    // Same human delivery identity as the worker's ensureHumanDeliveryIdentity.
    // Keep it stable through the worker relay's existing maximum of two attempts.
    const deliveryId = randomUUID();
    const body = {
      text: args.message,
      user: "agent",
      ...(callerInfo !== undefined ? { caller_info: callerInfo } : {}),
      delivery_id: deliveryId,
      delivery_intent: "human_live_steer",
      source: "user_message",
      completion_id: `message:${deliveryId}`,
      relation_key: `user_message:${targetSessionId}:${deliveryId}`,
      created_at: new Date().toISOString(),
    };
    let fallbackError = "orch relay failed";
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await executeSessionIntervention(options.sessionMessages!, SERVICE_CALLER, targetSessionId, body);
        if (response.status < 200 || response.status >= 300) {
          fallbackError = `orch POST /api/sessions/${targetSessionId}/intervene failed: ${response.status} ${STATUS_CODES[response.status] ?? ""}`;
          if (response.status >= 500 && attempt < 2) continue;
          break;
        }
        // Preserve OrchInterveneClient's ACK interpretation, including an absent verdict.
        const ack = JSON.parse(JSON.stringify(response.body)) as Record<string, unknown>;
        const delivered = typeof ack.delivered === "boolean" || ack.delivered === null ? ack.delivered : null;
        return jsonResult({ ok: true, detail: {
          relayed: true, target_session_id: targetSessionId, local_error: null,
          delivered, outcome: stringOrNull(ack.outcome),
          reason: stringOrNull(ack.reason) ?? (delivered === null ? "orch returned no intervene verdict" : null),
          consume_when: stringOrNull(ack.consumeWhen ?? ack.consume_when),
          queue_position: typeof ack.queuePosition === "number" ? ack.queuePosition
            : typeof ack.queue_position === "number" ? ack.queue_position : null,
        } });
      } catch (error) {
        fallbackError = error instanceof Error ? error.message : String(error);
      }
    }
    return jsonResult({ ok: false, error: null, fallback_error: fallbackError });
  },
} satisfies Record<keyof typeof sessionMessageTools, McpToolHandler>;

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
