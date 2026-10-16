import { createHash } from "node:crypto";

import type { AttachSessionOutputResult } from "@soulstream/mcp-contract";

import type { ChatUiPublisher } from "../mcp/runtime.js";
import {
  EventAcknowledgementTimeoutError,
  EventOutboxDeadLetterError,
  EventOutboxQuarantinedError,
} from "../upstream/event_outbox_pump.js";

export async function publishSessionOutputAttachment(params: {
  sessionId: string;
  outputCommandId: string;
  registrationId: string;
  attachmentIds: string[];
  publisher: ChatUiPublisher;
}): Promise<AttachSessionOutputResult> {
  const outputKey = `session-output:${createHash("sha256")
    .update(JSON.stringify([params.sessionId, params.outputCommandId, params.attachmentIds]))
    .digest("hex")}`;
  const event = {
    type: "assistant_message",
    content: "",
    attachment_ids: params.attachmentIds,
    attachment_output: true,
    output_command_id: params.outputCommandId,
    timestamp: Date.now() / 1000,
    _dedupe_key: outputKey,
  } as const;

  try {
    const { eventId } = await params.publisher.publish(
      params.sessionId,
      event,
      params.registrationId,
    );
    return {
      status: "committed",
      event_id: String(eventId),
      output_command_id: params.outputCommandId,
      attachment_ids: params.attachmentIds,
    };
  } catch (error) {
    if (error instanceof EventAcknowledgementTimeoutError) {
      return {
        status: "delivery_unconfirmed",
        output_key: outputKey,
        output_command_id: params.outputCommandId,
        attachment_ids: params.attachmentIds,
      };
    }
    if (error instanceof EventOutboxDeadLetterError || error instanceof EventOutboxQuarantinedError) {
      throw Object.assign(new Error("첨부 응답 저장이 확정 거절되었습니다."), {
        code: "ATTACHMENT_OUTPUT_REJECTED",
      });
    }
    throw error;
  }
}
