import { describe, expect, it } from "vitest";

import {
  buildClaudeBackgroundGenerationIdentity,
} from "../../src/task/claude_background_generation_identity.js";

describe("Claude background generation identity", () => {
  it("같은 task의 최초 Agent와 SendMessage resume을 initiating tool_use_id로 분리한다", () => {
    const common = {
      sourceNode: "node-windows",
      agentSessionId: "parent-session",
      sdkSessionId: "sdk-session",
      sdkTaskId: "a4e266f9c67987b3a",
    };
    const initial = buildClaudeBackgroundGenerationIdentity({
      ...common,
      initiatingToolUseId: "toolu_013PwZ12nfaZjqtmJhLGd9gM",
    });
    const resumed = buildClaudeBackgroundGenerationIdentity({
      ...common,
      initiatingToolUseId: "toolu_01GCrrtrKA5tQEkdN7XDBSDy",
    });

    expect(initial.generationKey).not.toBe(resumed.generationKey);
    expect(initial.relationKey).not.toBe(resumed.relationKey);
    expect(initial.completionId).not.toBe(resumed.completionId);
    expect(initial.deliveryId).not.toBe(resumed.deliveryId);
  });

  it("terminal revision과 stopped→killed 표현 변화는 identity 입력이 아니다", () => {
    const identity = buildClaudeBackgroundGenerationIdentity({
      sourceNode: "node-1",
      agentSessionId: "session-1",
      sdkSessionId: "sdk-1",
      sdkTaskId: "task-1",
      initiatingToolUseId: "toolu-start",
    });

    expect(Object.keys(identity).sort()).toEqual([
      "completionId",
      "deliveryId",
      "generationKey",
      "relationKey",
    ]);
  });

  it("canonical 구성요소가 비면 identity를 만들지 않는다", () => {
    expect(() => buildClaudeBackgroundGenerationIdentity({
      sourceNode: "node-1",
      agentSessionId: "session-1",
      sdkSessionId: "",
      sdkTaskId: "task-1",
      initiatingToolUseId: "toolu-start",
    })).toThrow("sdkSessionId");
  });
});
