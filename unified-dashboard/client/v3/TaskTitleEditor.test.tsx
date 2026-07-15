import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TaskTitleEditor } from "./TaskTitleEditor";

describe("TaskTitleEditor", () => {
  it("exposes the task title as a click-to-edit control", () => {
    const html = renderToStaticMarkup(
      <TaskTitleEditor title="업무 제목" onRename={vi.fn()} />,
    );

    expect(html).toContain("업무 제목");
    expect(html).toContain('aria-label="업무 제목 편집"');
    expect(html).toContain('title="클릭해서 업무 제목 편집"');
  });
});
