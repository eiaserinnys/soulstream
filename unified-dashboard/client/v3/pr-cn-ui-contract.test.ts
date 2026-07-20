import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("PR-CN planner polish contract", () => {
  it("moves planner actions into their owning headers and renames starred work", () => {
    const layout = read("./V3DashboardLayout.tsx");
    const toolbar = read("./V3GlobalToolbar.tsx");
    const views = read("./PlannerViews.tsx");
    const navigation = read("./V3Navigation.tsx");

    expect(toolbar).not.toContain("onOpenRitual");
    expect(toolbar).not.toContain("onOpenNewTask");
    expect(views).toContain('label="아침 정리"');
    expect(views.match(/label="새 업무"/g)).toHaveLength(2);
    expect(layout).toContain("onOpenRitual={() => setRitualOpen(true)}");
    expect(navigation).toContain("<h2>중요 작업</h2>");
    expect(navigation).not.toContain("<h2>★ 작업</h2>");
    expect(navigation).toContain('<span className="v3-emoji" aria-hidden="true">📅</span>');
  });

  it("keeps memo semantics while removing its visible title and centers project content", () => {
    const memo = read("./DailyMemo.tsx");
    const views = read("./PlannerViews.tsx");

    expect(memo).not.toContain('className="v3-memo-label"');
    expect(memo).toContain('ariaLabel={index === 0 ? "오늘 메모"');
    expect(views).toMatch(/function ProjectPlannerView[\s\S]*className="v3-planner-column"/);
  });

  it("removes session-only guidance and reuses the attachment submission contract", () => {
    const modal = read("./SessionSuccessionModal.tsx");

    expect(modal).not.toContain("추가 지침");
    expect(modal).not.toContain("setGuidance");
    expect(modal).toContain("useFileUpload");
    expect(modal).toContain("appendAttachmentPathNotes");
    expect(modal).toContain("attachmentPaths");
    expect(modal).toContain("/api/attachments/sessions?nodeId=");
    expect(modal).toContain("resetLocal");
    expect(modal).toContain("cancel");
  });

  it("keeps the morning ritual on daily membership and never requests task completion", () => {
    const ritual = read("./RitualModal.tsx");
    const model = read("./ritual-model.ts");
    const browserPort = read("./ritual-browser-port.ts");

    expect(ritual).toContain("데일리에서 내리기");
    expect(ritual).not.toContain("완료 처리");
    expect(model).not.toContain("completeTask");
    expect(browserPort).not.toContain("postTaskStatus");
  });
});
