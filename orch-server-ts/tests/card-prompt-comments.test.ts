import { describe, expect, it } from "vitest";
import { buildCardPrompt } from "../src/cards/card_prompt.js";

describe("card comment prompt and reporting guidance", () => {
  it("includes each comment timestamp, ID, and body only when comments exist", () => {
    const base = { cardId: "c1", title: "작업", folderName: "실험", request: "원문", brief: "경과", running: [] };
    const withoutComments = buildCardPrompt(base);
    expect(withoutComments).not.toContain("## 커멘트");
    const withComments = buildCardPrompt({ ...base, comments: [{ id:"comment-1",createdAt: "2026-09-30T00:00:00.000Z", body: "다음 단계로 진행" }] });
    expect(withComments).toContain("## 커멘트\n- 2026-09-30T00:00:00.000Z\n  커멘트 ID: comment-1\n  다음 단계로 진행");
  });

  it("ends at the running-sessions section without rules or queue sections", () => {
    const prompt = buildCardPrompt({ cardId: "c1", title: "작업", folderName: "실험", request: "원문", brief: "경과",
      running: [{ title: "다른 작업", folderName: "개발" }] });
    expect(prompt).not.toContain("## 카드 규칙");
    expect(prompt).not.toContain("## 대기열");
    expect(prompt.endsWith("## 지금 실행 중인 다른 카드 세션\n다른 작업 (개발)")).toBe(true);
  });
});
