import { describe, expect, it } from "vitest";

import {
  buildDeliveryInputUuid,
  buildDeterministicDeliveryIdentity,
  hashDeliveryPayload,
} from "../../src/task/delivery_identity.js";

describe("delivery identity", () => {
  it("keeps one semantic relation stable when a delivery target is replaced", () => {
    const original = buildDeterministicDeliveryIdentity({
      targetSessionId: "caller-old",
      relationKey: "child_session:child-1:42",
      intent: "completion_notification",
    });
    const replacement = buildDeterministicDeliveryIdentity({
      targetSessionId: "caller-new",
      relationKey: "child_session:child-1:42",
      intent: "completion_notification",
    });

    expect(replacement).toEqual(original);
  });

  it("derives one valid SDK input UUID from a durable delivery id", () => {
    const first = buildDeliveryInputUuid("delivery-semantic-1");
    const replay = buildDeliveryInputUuid("delivery-semantic-1");
    const different = buildDeliveryInputUuid("delivery-semantic-2");

    expect(replay).toBe(first);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(different).not.toBe(first);
  });

  it("canonicalizes object key order while retaining attachment, context, and caller identity", () => {
    const first = hashDeliveryPayload({
      text: "done",
      attachment_paths: ["/tmp/result.png"],
      context: [{ key: "task", content: "render" }],
      caller_info: { source: "agent", agent_id: "child-1" },
    });
    const reordered = hashDeliveryPayload({
      caller_info: { agent_id: "child-1", source: "agent" },
      context: [{ content: "render", key: "task" }],
      attachment_paths: ["/tmp/result.png"],
      text: "done",
    });
    const differentAttachment = hashDeliveryPayload({
      text: "done",
      attachment_paths: ["/tmp/other.png"],
      context: [{ key: "task", content: "render" }],
      caller_info: { source: "agent", agent_id: "child-1" },
    });

    expect(reordered).toBe(first);
    expect(differentAttachment).not.toBe(first);
  });
});
