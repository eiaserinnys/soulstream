import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TaskDescriptionPanel } from "./TaskDescriptionPanel";

describe("TaskDescriptionPanel", () => {
  it("uses the corrected empty-state sentence", () => {
    const html = renderToStaticMarkup(
      <TaskDescriptionPanel markdown="" onSave={vi.fn()} />,
    );

    expect(html).toContain("클릭해서 업무 설명을 작성하세요.");
    expect(html).not.toContain("클릭해 업무 설명을 작성하세요.");
  });

  it("always renders a long description without a collapse control", () => {
    const html = renderToStaticMarkup(
      <TaskDescriptionPanel markdown={"장문 설명 😀 ".repeat(80)} onSave={vi.fn()} />,
    );

    expect(html).not.toContain("data-expanded");
    expect(html).not.toContain("v3-bounded-markdown");
    expect(html).not.toContain("전체 보기");
    expect(html).not.toContain("접기");
    expect(html).toContain("편집");
  });

  it("does not show an expand action for a short description", () => {
    const html = renderToStaticMarkup(
      <TaskDescriptionPanel markdown="짧은 설명" onSave={vi.fn()} />,
    );

    expect(html).not.toContain("전체 보기");
    expect(html).toContain("편집");
  });

  it("exposes the description editor as the reusable compact markdown surface", () => {
    const html = renderToStaticMarkup(
      <TaskDescriptionPanel
        markdown="오늘 기억할 내용"
        onSave={vi.fn()}
        ariaLabel="오늘 메모"
        emptyText="오늘 기억해 둘 내용을 적으세요."
        variant="compact"
      />,
    );

    expect(html).toContain('data-editor-variant="compact"');
    expect(html).toContain('aria-label="오늘 메모 편집"');
    expect(html).not.toContain("전체 보기");
  });

  it("keeps keyboard completion but removes editor meta labels", () => {
    const html = renderToStaticMarkup(
      <TaskDescriptionPanel
        markdown="오늘 기억할 내용"
        onSave={vi.fn()}
        ariaLabel="오늘 메모"
        variant="compact"
        initialEditing
      />,
    );

    expect(html).toContain('aria-label="오늘 메모 마크다운"');
    expect(html).toContain("완료");
    expect(html).not.toContain("Ctrl");
    expect(html).not.toContain("마크다운 ·");
  });
});
