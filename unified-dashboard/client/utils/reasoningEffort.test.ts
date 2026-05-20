import { describe, expect, it } from "vitest";

import {
  backendSupportsReasoningEffort,
  reasoningEffortForSubmit,
  selectedAgentBackend,
} from "./reasoningEffort";

describe("reasoning effort UI helper", () => {
  it("codex backend에서만 컨트롤을 표시한다", () => {
    expect(backendSupportsReasoningEffort("codex")).toBe(true);
    expect(backendSupportsReasoningEffort("claude")).toBe(false);
    expect(backendSupportsReasoningEffort("other")).toBe(false);
    expect(backendSupportsReasoningEffort(null)).toBe(false);
  });

  it("선택 agent backend를 찾고 없으면 null", () => {
    const agents = [
      { id: "a", backend: "claude" },
      { id: "b", backend: "codex" },
    ];
    expect(selectedAgentBackend(agents, "b")).toBe("codex");
    expect(selectedAgentBackend(agents, "missing")).toBeNull();
  });

  it("기본 submit 값은 xhigh이고 선택값을 payload 값으로 돌려준다", () => {
    expect(reasoningEffortForSubmit("codex")).toBe("xhigh");
    expect(reasoningEffortForSubmit("codex", "medium")).toBe("medium");
  });

  it("비추론 backend에는 submit payload 필드를 넣지 않는다", () => {
    expect(reasoningEffortForSubmit("other", "high")).toBeUndefined();
    expect(reasoningEffortForSubmit(null, "high")).toBeUndefined();
  });
});
