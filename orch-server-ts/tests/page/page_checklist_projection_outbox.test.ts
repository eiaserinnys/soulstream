import { describe, expect, it, vi } from "vitest";

import { reconcileChecklistProjectionOutbox } from "../../src/page/page_checklist_projection_outbox.js";

describe("checklist projection outbox ingress", () => {
  it("coalesces any number of checklist blocks into two bounded SQL statements", async () => {
    const calls: string[] = [];
    const sql = Object.assign(
      async (strings: TemplateStringsArray) => {
        calls.push(Array.from(strings).join("?"));
        return [];
      },
      {
        json: vi.fn((value: unknown) => value),
        array: vi.fn((values: readonly unknown[]) => values),
      },
    );
    const blocks = Array.from({ length: 100 }, (_, index) => ({
      id: `check-${index}`,
      parentId: null,
      positionKey: String(index).padStart(3, "0"),
      type: "checklist" as const,
      text: `Task ${index}`,
      textDelta: [{ insert: `Task ${index}` }],
      properties: { checked: false },
      collapsed: false,
    }));

    await reconcileChecklistProjectionOutbox(sql as never, {
      page: {
        id: "page-1",
        title: "Page",
        dailyDate: null,
        mutationVersion: 1,
        archived: false,
        metadata: {},
      },
      blocks,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("jsonb_to_recordset");
    expect(calls[1]).toContain("archive:");
    expect(sql.array).toHaveBeenCalledWith(blocks.map((block) => block.id));
  });
});
