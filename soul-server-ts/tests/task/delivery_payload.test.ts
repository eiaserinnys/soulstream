import { describe, expect, it } from "vitest";

import {
  buildCanonicalDeliveryPayload,
  readCanonicalDeliveryPayload,
} from "../../src/task/delivery_payload.js";

describe("canonical delivery payload", () => {
  it.each([
    { text: "앞에 이거 뭐야?", user: "", attachmentPaths: undefined },
    { text: "", user: "", attachmentPaths: ["uploads/screenshot.png"] },
  ])("round-trips accepted external messages: %j", (message) => {
    const callerInfo = { source: "slack", display_name: "Director" };
    const canonical = buildCanonicalDeliveryPayload({
      ...message,
      source: "user_message",
      completionId: "message:external",
      relationKey: "user_message:session:external",
      callerInfo,
    });

    expect(readCanonicalDeliveryPayload(canonical.payload)).toMatchObject({
      ...message,
      callerInfo,
    });
  });

  it.each(["text", "user"])("rejects a missing or non-string %s", (field) => {
    for (const value of [undefined, null, 42]) {
      expect(() => readCanonicalDeliveryPayload({
        text: "message",
        user: "system",
        [field]: value,
      })).toThrow(`Stored delivery payload is missing ${field}`);
    }
  });

  it("round-trips attachment ids and bindings through the canonical payload", () => {
    const bindings = [
      { attachment_id: "att-a", node_id: "node-1", path: "/tmp/a.png" },
    ];
    const canonical = buildCanonicalDeliveryPayload({
      text: "look",
      user: "",
      source: "user_message",
      completionId: "message:ids",
      relationKey: "user_message:session:ids",
      attachmentPaths: ["/tmp/a.png"],
      attachmentIds: ["att-a"],
      attachmentBindings: bindings,
    });

    expect(canonical.payload).toMatchObject({
      attachment_ids: ["att-a"],
      attachment_bindings: bindings,
    });
    expect(readCanonicalDeliveryPayload(canonical.payload)).toMatchObject({
      attachmentPaths: ["/tmp/a.png"],
      attachmentIds: ["att-a"],
      attachmentBindings: bindings,
    });
  });
  it("round-trips conversation display text independently of agent input", () => {
    const canonical=buildCanonicalDeliveryPayload({
      text:"visible\n\nagent context",
      conversationText:"visible",
      user:"",
      source:"user_message",
      completionId:"message:context",
      relationKey:"user_message:session:context",
    });
    expect(canonical.payload._conversation_text).toBe("visible");
    expect(readCanonicalDeliveryPayload(canonical.payload).conversationText).toBe("visible");
    expect(readCanonicalDeliveryPayload({text:"legacy",user:""}).conversationText).toBeUndefined();
  });

  it("keeps a stable hash for the same ids and changes it when ids change", () => {
    const build = (attachmentId: string) => buildCanonicalDeliveryPayload({
      text: "look",
      user: "system",
      source: "user_message",
      completionId: "message:hash",
      relationKey: "user_message:session:hash",
      attachmentPaths: ["/tmp/a.png"],
      attachmentIds: [attachmentId],
      attachmentBindings: [
        { attachment_id: attachmentId, node_id: "node-1", path: "/tmp/a.png" },
      ],
    });

    const first = build("att-a");
    const again = build("att-a");
    const changed = build("att-b");

    expect(again.payloadHash).toBe(first.payloadHash);
    expect(changed.payloadHash).not.toBe(first.payloadHash);
  });

  it("treats undefined and empty id inputs as the legacy no-attachment payload", () => {
    const base = {
      text: "look",
      user: "system",
      source: "user_message",
      completionId: "message:legacy",
      relationKey: "user_message:session:legacy",
      attachmentPaths: ["/tmp/a.png"],
    };
    const legacy = buildCanonicalDeliveryPayload(base);
    const empty = buildCanonicalDeliveryPayload({
      ...base,
      attachmentIds: [],
      attachmentBindings: [],
    });

    expect(legacy.payload).not.toHaveProperty("attachment_ids");
    expect(legacy.payload).not.toHaveProperty("attachment_bindings");
    expect(empty.payload).toEqual(legacy.payload);
    expect(empty.payloadHash).toBe(legacy.payloadHash);
  });

  it("reuses a stored payload with ids at the same hash", () => {
    const bindings = [
      { attachment_id: "att-a", node_id: "node-1", path: "/tmp/a.png" },
    ];
    const identity = {
      text: "look",
      user: "system",
      source: "user_message",
      completionId: "message:stored",
      relationKey: "user_message:session:stored",
    };
    const stored = buildCanonicalDeliveryPayload({
      ...identity,
      attachmentPaths: ["/tmp/a.png"],
      attachmentIds: ["att-a"],
      attachmentBindings: bindings,
    });

    const reread = readCanonicalDeliveryPayload(stored.payload);
    const rebuilt = buildCanonicalDeliveryPayload({
      ...identity,
      attachmentPaths: reread.attachmentPaths,
      attachmentIds: reread.attachmentIds,
      attachmentBindings: reread.attachmentBindings,
    });

    expect(rebuilt.payload).toEqual(stored.payload);
    expect(rebuilt.payloadHash).toBe(stored.payloadHash);
  });

  it("round-trips runtime follow-up identity without relation_key reuse", () => {
    const canonical = buildCanonicalDeliveryPayload({
      text: "background task finished",
      user: "system",
      source: "claude_runtime_task_followup",
      completionId: "completion-2",
      relationKey: "runtime:session:task:fallback-2",
      followupKey: "session:task",
      followupAttempt: 2,
      followupTaskIds: ["task-1"],
    });

    expect(canonical.payload).toMatchObject({
      followup_key: "session:task",
      followup_attempt: 2,
      followup_task_ids: ["task-1"],
    });
    expect(readCanonicalDeliveryPayload(canonical.payload)).toMatchObject({
      followupKey: "session:task",
      followupAttempt: 2,
      followupTaskIds: ["task-1"],
    });
  });
});
