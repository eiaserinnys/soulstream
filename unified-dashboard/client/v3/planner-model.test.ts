import { describe, expect, it } from "vitest";

import {
  classifyMountedPage,
  derivePlannerTaskStatus,
  plannerStatusPresentation,
} from "./planner-model";

describe("classifyMountedPage", () => {
  it("classifies a page with a primary runbook_ref as a task", () => {
    expect(classifyMountedPage([
      block("paragraph", {}),
      block("runbook_ref", { runbookId: "rb-1", primary: true }),
    ])).toEqual({ kind: "task", runbookId: "rb-1" });
  });

  it("classifies pages without a valid primary reference as documents", () => {
    expect(classifyMountedPage([block("paragraph", {})])).toEqual({ kind: "document" });
    expect(classifyMountedPage([
      block("runbook_ref", { runbookId: "rb-secondary", primary: false }),
    ])).toEqual({ kind: "document" });
  });
});

describe("planner task status", () => {
  it("derives review and in-progress states from open runbook items", () => {
    expect(derivePlannerTaskStatus(snapshot("open", ["pending"]))).toBe("open");
    expect(derivePlannerTaskStatus(snapshot("open", ["in_progress"]))).toBe("in_progress");
    expect(derivePlannerTaskStatus(snapshot("open", ["in_progress", "review"]))).toBe("review");
    expect(derivePlannerTaskStatus(snapshot("completed", ["review"]))).toBe("completed");
  });

  it("maps canonical states to the mockup chips", () => {
    expect(plannerStatusPresentation("open")).toMatchObject({ icon: "○", label: "Open" });
    expect(plannerStatusPresentation("in_progress")).toMatchObject({ icon: "●", label: "진행" });
    expect(plannerStatusPresentation("review")).toMatchObject({ icon: "◆", label: "검수" });
    expect(plannerStatusPresentation("completed")).toMatchObject({ icon: "✓", label: "완료" });
  });
});

function block(blockType: string, properties: Record<string, unknown>) {
  return {
    id: `block-${blockType}`,
    page_id: "page-1",
    parent_id: null,
    position_key: "a0",
    block_type: blockType,
    text: "",
    properties,
    collapsed: false,
  };
}

function snapshot(status: string, itemStatuses: string[]) {
  return {
    runbook: { status },
    items: itemStatuses.map((itemStatus) => ({ status: itemStatus })),
  };
}
