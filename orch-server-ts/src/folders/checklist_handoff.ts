import { buildCanonicalDeliveryPayload } from "@soulstream/wire-schema/delivery";
import type { SessionDeliveryRepository } from "../control_plane/repositories/session_delivery_repository.js";
import type { NodeCommandResponse } from "../node/pending_commands.js";
import type { InterveneNodeCommandPayload } from "../session/session_action_command_payloads.js";
import type { FolderHandoffEvent } from "../tasks/control_plane/task_types.js";

/** Preserve human completion notifications through the existing durable session delivery path. */
export async function notifyChecklistHandoff(
  event: FolderHandoffEvent,
  subscribers: string[],
  ports: {
    deliveries: Pick<SessionDeliveryRepository, "register">;
    send: (payload: InterveneNodeCommandPayload) => Promise<NodeCommandResponse>;
    warn: (message: string) => void;
  },
): Promise<void> {
  const text = [
    `폴더 '${event.folderName}'의 '${event.itemTitle}' ${event.status === "completed" ? "완료" : "취소"}됨, 이어서 진행`,
    "", `folder_id: ${event.folderId}`, `item_id: ${event.itemId}`,
    `status: ${event.status}`, `operation_id: ${event.operationId}`, `event_id: ${event.eventId}`,
  ].join("\n");
  for (const targetSessionId of subscribers) {
    try {
      const relationKey = ["checklist_handoff", event.folderId, event.operationId, event.itemId, targetSessionId].join(":");
      const completionId = `completion:${relationKey}`;
      const canonical = buildCanonicalDeliveryPayload({
        text, user: "agent", source: "checklist_handoff", completionId, relationKey,
      });
      const registered = await ports.deliveries.register({
        deliveryId: relationKey, targetSessionId, relationKey, completionId,
        intent: "durable_next_turn", source: "checklist_handoff",
        producerTerminalRevision: String(event.eventId),
        payloadHash: canonical.payloadHash, payload: canonical.payload,
      });
      if (registered.conflict) throw new Error("Checklist handoff delivery identity conflict");
      const result = await ports.send({
        type: "intervene", agentSessionId: targetSessionId, text, user: "agent",
        delivery_id: relationKey, delivery_intent: "durable_next_turn", source: "checklist_handoff",
        completion_id: completionId, relation_key: relationKey,
        producer_terminal_revision: String(event.eventId),
      });
      if (result.status === "error") throw new Error(String(result.message));
    } catch (error) {
      ports.warn(`Checklist handoff to ${targetSessionId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
