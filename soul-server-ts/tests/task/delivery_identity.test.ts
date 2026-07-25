import { describe, expect, it } from "vitest";

import {
  buildDeterministicDeliveryIdentity,
  hashDeliveryPayload,
} from "../../src/task/delivery_identity.js";

describe("delivery identity", () => {
  it("keeps one semantic relation stable when a supervisor target is replaced", () => {
    const original = buildDeterministicDeliveryIdentity({
      targetSessionId: "supervisor-old",
      relationKey: "child_session:child-1:42",
      intent: "completion_notification",
    });
    const replacement = buildDeterministicDeliveryIdentity({
      targetSessionId: "supervisor-new",
      relationKey: "child_session:child-1:42",
      intent: "completion_notification",
    });

    expect(replacement).toEqual(original);
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
