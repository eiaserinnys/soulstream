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
});
