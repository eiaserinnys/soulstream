import { describe, expect, it } from "vitest";
import { buildCardPrompt } from "../src/cards/card_prompt.js";

describe("card comment prompt and reporting guidance", () => {
  it("shows the current status of predecessor cards in the start prompt", () => {
    const prompt = buildCardPrompt({ cardId: "c1", folderId: "f1", title: "뒤", folderName: "실험", request: "", brief: "", running: [],
      dependsOn: [{ id: "c2", number: 12, title: "앞", status: "done", archived: false, met: true }] });
    expect(prompt).toContain("선행 카드: #12 앞(완료)");
  });
  it("includes each comment timestamp, ID, and body only when comments exist", () => {
    const base = { cardId: "c1", folderId: "f1", title: "작업", folderName: "실험", request: "원문", brief: "경과", running: [] };
    const withoutComments = buildCardPrompt(base);
    expect(withoutComments).not.toContain("## 커멘트");
    const withComments = buildCardPrompt({ ...base, comments: [{ id:"comment-1",createdAt: "2026-09-30T00:00:00.000Z", body: "다음 단계로 진행" }] });
    expect(withComments).toContain("## 커멘트\n- 2026-09-30T00:00:00.000Z\n  커멘트 ID: comment-1\n  다음 단계로 진행");
  });

  it("ends at the running-sessions section without rules or queue sections", () => {
    const prompt = buildCardPrompt({ cardId: "c1", folderId: "f1", title: "작업", folderName: "실험", request: "원문", brief: "경과",
      running: [{ id: "c2", folder_id: "f1", number: 42, title: "다른 작업" }] });
    expect(prompt).not.toContain("## 카드 규칙");
    expect(prompt).not.toContain("## 대기열");
    expect(prompt.endsWith("## 같은 폴더에서 실행 중인 다른 카드\n#42 다른 작업")).toBe(true);
  });

  it("lists the first ten other cards in the same folder, with optional numbers", () => {
    const matching = Array.from({ length: 11 }, (_, index) => ({
      id: `other-${index}`, folder_id: "f1", number: index === 1 ? null : index + 1, title: `작업 ${index}`,
    }));
    const prompt = buildCardPrompt({ cardId: "c1", folderId: "f1", title: "현재", folderName: "실험", request: "원문", brief: "경과",
      running: [
        { id: "c1", folder_id: "f1", number: 100, title: "자기 자신" },
        { id: "elsewhere", folder_id: "f2", number: 200, title: "다른 폴더" },
        ...matching,
      ] });
    expect(prompt.split("## 같은 폴더에서 실행 중인 다른 카드\n")[1]).toBe(
      ["#1 작업 0", "작업 1", ...Array.from({ length: 8 }, (_, index) => `#${index + 3} 작업 ${index + 2}`)].join("\n"),
    );
    expect(prompt).not.toContain("자기 자신");
    expect(prompt).not.toContain("다른 폴더");
    expect(prompt).not.toContain("작업 10");
  });

  it("omits the section when no other cards belong to the same folder", () => {
    const prompt = buildCardPrompt({ cardId: "c1", folderId: "f1", title: "현재", folderName: "실험", request: "원문", brief: "경과",
      running: [
        { id: "c1", folder_id: "f1", number: 1, title: "자기 자신" },
        { id: "c2", folder_id: "f2", number: null, title: "다른 폴더" },
      ] });
    expect(prompt).toBe("[카드 실행] 이 세션은 카드 c1 「현재」(폴더 실험)을 맡았다.\n\n## 카드 도구를 쓸 때\n판 충돌(카드의 판이 바뀌었다는 거절)이 나면 get_card로 card.version을 다시 읽고 한 번 더 부른다.\n\n## 요청 원문\n원문\n\n## 인계 요약 (지금까지)\n경과");
  });
});
