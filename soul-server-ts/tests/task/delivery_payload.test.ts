import { describe, expect, it } from "vitest";

import {
  buildCanonicalDeliveryPayload,
  readCanonicalDeliveryPayload,
} from "../../src/task/delivery_payload.js";

describe("canonical delivery payload", () => {
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
