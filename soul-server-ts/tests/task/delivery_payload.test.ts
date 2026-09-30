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
