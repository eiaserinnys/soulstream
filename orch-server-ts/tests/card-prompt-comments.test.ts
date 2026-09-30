import { describe, expect, it } from "vitest";
import { buildCardPrompt } from "../src/cards/card_prompt.js";

describe("card comment prompt and reporting guidance", () => {
  it("includes each comment timestamp and body only when comments exist", () => {
    const base = { cardId: "c1", title: "작업", folderName: "실험", request: "원문", brief: "경과", running: [], queued: [] };
    const withoutComments = buildCardPrompt(base);
    expect(withoutComments).not.toContain("## 커멘트");
    const withComments = buildCardPrompt({ ...base, comments: [{ createdAt: "2026-09-30T00:00:00.000Z", body: "다음 단계로 진행" }] });
    expect(withComments).toContain("## 커멘트\n- 2026-09-30T00:00:00.000Z\n  다음 단계로 진행");
  });

  it("uses the director brief and report formats agreed for card prompts", () => {
    const prompt = buildCardPrompt({ cardId: "c1", title: "작업", folderName: "실험", request: "원문", brief: "경과", running: [], queued: [] });
    expect(prompt).toContain("brief도 한 문장 + 불릿.");
    expect(prompt).toContain("보고는 디렉터용이다. 바쁜 상급자에게 보고하듯 쓴다: 첫 줄은 무엇을 하여 무엇이 됐는지 한 문장, 그 아래 불릿 3~5개는 각각 '~합니다'로 끝나는 짧은 완결 문장(된 것, 확인한 것, 자료 위치). 캡처·표·그림과 증거 링크(PR, SHA, URL)는 그 다음. 긴 설명은 접힘 블록으로.");
  });
});
