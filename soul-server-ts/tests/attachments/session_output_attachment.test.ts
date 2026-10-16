import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { publishSessionOutputAttachment } from "../../src/attachments/session_output_attachment.js";
import type { ChatUiPublisher } from "../../src/mcp/runtime.js";
import {
  EventAcknowledgementTimeoutError,
  EventOutboxDeadLetterError,
  EventOutboxQuarantinedError,
} from "../../src/upstream/event_outbox_pump.js";

const outputKey = (sessionId: string, outputCommandId: string, attachmentIds: string[]) =>
  `session-output:${createHash("sha256")
    .update(JSON.stringify([sessionId, outputCommandId, attachmentIds]))
    .digest("hex")}`;

function request(publisher: ChatUiPublisher, attachmentIds = ["att-1", "att-2"]) {
  return {
    sessionId: "session-1",
    outputCommandId: "command-1",
    registrationId: "registration-1",
    attachmentIds,
    publisher,
  };
}

describe("publishSessionOutputAttachment", () => {
  it("publishes one empty assistant marker with the stable command and IDs", async () => {
    const publish = vi.fn(async () => ({ eventId: 73 }));
    const publisher = { publish } as unknown as ChatUiPublisher;

    const result = await publishSessionOutputAttachment(request(publisher));

    expect(result).toEqual({
      status: "committed",
      event_id: "73",
      output_command_id: "command-1",
      attachment_ids: ["att-1", "att-2"],
    });
    expect(publish).toHaveBeenCalledOnce();
    const [sessionId, event, registrationId] = publish.mock.calls[0]!;
    expect(sessionId).toBe("session-1");
    expect(registrationId).toBe("registration-1");
    expect(event).toMatchObject({
      type: "assistant_message",
      content: "",
      attachment_ids: ["att-1", "att-2"],
      attachment_output: true,
      output_command_id: "command-1",
      timestamp: expect.any(Number),
      _dedupe_key: outputKey("session-1", "command-1", ["att-1", "att-2"]),
    });
  });

  it("keeps retry identity stable for the same command and ordered IDs", async () => {
    const publish = vi.fn(async () => ({ eventId: 73 }));
    const publisher = { publish } as unknown as ChatUiPublisher;

    await publishSessionOutputAttachment(request(publisher));
    await publishSessionOutputAttachment(request(publisher));
    await publishSessionOutputAttachment(request(publisher, ["att-2", "att-1"]));

    const keys = publish.mock.calls.map((call) => call[1]._dedupe_key);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("reports an acknowledgement timeout as unconfirmed while preserving the retry key", async () => {
    const publish = vi.fn(async () => {
      throw new EventAcknowledgementTimeoutError(4, 30_000);
    });
    const publisher = { publish } as unknown as ChatUiPublisher;

    const result = await publishSessionOutputAttachment(request(publisher));

    expect(result).toEqual({
      status: "delivery_unconfirmed",
      output_key: outputKey("session-1", "command-1", ["att-1", "att-2"]),
      output_command_id: "command-1",
      attachment_ids: ["att-1", "att-2"],
    });
  });

  it.each([
    new EventOutboxDeadLetterError(4, "REJECTED", "now", "rejected"),
    new EventOutboxQuarantinedError(4, "QUARANTINED", "now", "quarantined"),
  ])("surfaces definite outbox rejection as ATTACHMENT_OUTPUT_REJECTED", async (error) => {
    const publish = vi.fn(async () => { throw error; });
    const publisher = { publish } as unknown as ChatUiPublisher;

    await expect(publishSessionOutputAttachment(request(publisher))).rejects.toMatchObject({
      code: "ATTACHMENT_OUTPUT_REJECTED",
    });
  });
});
