import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DailyMemo } from "./DailyMemo";

describe("DailyMemo", () => {
  it("uses the task description click-to-edit surface instead of an always-open textarea", () => {
    const html = renderToStaticMarkup(
      <DailyMemo
        blocks={[{
          id: "memo-1",
          page_id: "daily-1",
          parent_id: null,
          position_key: "a0",
          block_type: "paragraph",
          text: "오늘 기억할 내용",
          properties: {},
          collapsed: false,
        }]}
        onSave={vi.fn(async () => undefined)}
      />,
    );

    expect(html).toContain("오늘 기억할 내용");
    expect(html).toContain('aria-label="오늘 메모 편집"');
    expect(html).not.toContain("<textarea");
  });
});
