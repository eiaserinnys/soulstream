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
    expect(html).toContain('aria-label="업무 설명 편집"');
    expect(html).toContain('title="업무 설명 편집"');
  });

  it("does not show an expand action for a short description", () => {
    const html = renderToStaticMarkup(
      <TaskDescriptionPanel markdown="짧은 설명" onSave={vi.fn()} />,
    );

    expect(html).not.toContain("전체 보기");
    expect(html).toContain('aria-label="업무 설명 편집"');
  });

  it("exposes the description editor as the reusable compact markdown surface", () => {
    const html = renderToStaticMarkup(
      <TaskDescriptionPanel
        markdown="**오늘** 기억할 내용"
        onSave={vi.fn()}
        ariaLabel="오늘 메모"
        emptyText="오늘 기억해 둘 내용을 적으세요."
        variant="daily"
      />,
    );

    expect(html).toContain('data-editor-variant="daily"');
    expect(html).toContain('aria-label="오늘 메모 편집"');
    expect(html).toMatch(/<strong[^>]*>오늘<\/strong>/);
    expect(html).not.toContain("전체 보기");
  });

  it("uses the icon-cap save action for the compact daily memo editor", () => {
    const html = renderToStaticMarkup(
      <TaskDescriptionPanel
        markdown="오늘 기억할 내용"
        onSave={vi.fn()}
        ariaLabel="오늘 메모"
        variant="daily"
        initialEditing
      />,
    );

    expect(html).toContain('aria-label="오늘 메모 마크다운"');
    expect(html).toContain('data-slot="dashboard-icon-cap"');
    expect(html).toContain('aria-label="오늘 메모 저장"');
    expect(html).toContain("lucide-check");
    expect(html).not.toContain(">완료<");
    expect(html).not.toContain("Ctrl");
    expect(html).not.toContain("마크다운 ·");
  });

  it("keeps the existing text completion action for the default task description editor", () => {
    const html = renderToStaticMarkup(
      <TaskDescriptionPanel markdown="업무 설명" onSave={vi.fn()} initialEditing />,
    );

    expect(html).toContain(">완료<");
    expect(html).not.toContain('aria-label="업무 설명 저장"');
  });

  it("keeps the existing text completion action for compact project guidance", () => {
    const html = renderToStaticMarkup(
      <TaskDescriptionPanel markdown="프로젝트 guidance" onSave={vi.fn()} ariaLabel="프로젝트 guidance" variant="compact" initialEditing />,
    );

    expect(html).toContain(">완료<");
    expect(html).not.toContain('aria-label="프로젝트 guidance 저장"');
  });
});
