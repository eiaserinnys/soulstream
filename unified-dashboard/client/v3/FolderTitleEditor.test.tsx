import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { FolderTitleEditor } from "./FolderTitleEditor";

describe("FolderTitleEditor", () => {
  it("exposes the task title as a click-to-edit control", () => {
    const html = renderToStaticMarkup(
      <FolderTitleEditor title="폴더 제목" onRename={vi.fn()} />,
    );

    expect(html).toContain("폴더 제목");
    expect(html).toContain('aria-label="폴더 제목 편집"');
    expect(html).toContain('title="클릭해서 폴더 제목 편집"');
  });
});
