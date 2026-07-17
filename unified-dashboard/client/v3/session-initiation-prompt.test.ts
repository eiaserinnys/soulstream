import { describe, expect, it } from "vitest";

import { buildSessionInitiationPrompt } from "./session-initiation-prompt";

describe("buildSessionInitiationPrompt", () => {
  it.each(["", "   ", "\n\t"])('uses the waiting prompt for empty input %j', (input) => {
    expect(buildSessionInitiationPrompt(input)).toBe(
      "업무 현황을 파악한 후, 사용자의 다음 지시를 대기해주세요.",
    );
  });

  it("combines the execution prompt and normalized initial instruction", () => {
    expect(buildSessionInitiationPrompt("  첫 결과를 요약하세요.\n근거도 남기세요.  ")).toBe(
      "업무 현황을 파악한 후, 사용자의 다음 지시를 이행해주세요.\n첫 결과를 요약하세요.\n근거도 남기세요.",
    );
  });
});
