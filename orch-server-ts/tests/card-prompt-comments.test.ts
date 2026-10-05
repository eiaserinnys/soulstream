import { describe, expect, it } from "vitest";
import { buildCardPrompt } from "../src/cards/card_prompt.js";

describe("card comment prompt and reporting guidance", () => {
  it("includes each comment timestamp, ID, and body only when comments exist", () => {
    const base = { cardId: "c1", title: "작업", folderName: "실험", request: "원문", brief: "경과", running: [], queued: [] };
    const withoutComments = buildCardPrompt(base);
    expect(withoutComments).not.toContain("## 커멘트");
    const withComments = buildCardPrompt({ ...base, comments: [{ id:"comment-1",createdAt: "2026-09-30T00:00:00.000Z", body: "다음 단계로 진행" }] });
    expect(withComments).toContain("## 커멘트\n- 2026-09-30T00:00:00.000Z\n  커멘트 ID: comment-1\n  다음 단계로 진행");
  });

  it("uses the director brief and report formats agreed for card prompts", () => {
    const prompt = buildCardPrompt({ cardId: "c1", title: "작업", folderName: "실험", request: "원문", brief: "경과", running: [], queued: [] });
    expect(prompt).toContain("기존 확인 항목을 읽고, 항목이 없으면 set_card_items로 요청을 확인 항목으로 나눈다.");
    expect(prompt).toContain("진행과 기술 세부는 add_card_note로 노트에 쓴다.");
    expect(prompt).toContain("request_card_review의 ask에 사용자가 볼 것을 한 줄로 적어 검수를 요청한다.");
    expect(prompt).not.toContain("add_card_report");
    expect(prompt).toContain("바로 시작하려면 run=true, 순서를 기다려도 되면 queue=true를 준다.");
  });
});
