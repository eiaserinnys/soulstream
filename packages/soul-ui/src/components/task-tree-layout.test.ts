import { describe, expect, it } from "vitest";
import type { TaskItem } from "../shared";
import {
  buildTaskStreamUrl,
  buildTaskTreeRows,
  resolveTaskTreeHeaderAction,
} from "./task-tree-layout";
import { STATUS_META, STATUS_OPTIONS } from "./TaskTreeParts";

function task(id: string, parentId: string | null, positionKey: number): TaskItem {
  return {
    id,
    parentId,
    positionKey,
    title: id,
    description: "",
    acceptanceCriteria: "",
    verificationOwner: "agent",
    status: "open",
    linkedSessionId: null,
    linkedNodeId: null,
    activeForSessionId: null,
    createdFromSessionId: "parent-session",
    createdFromEventId: null,
    navigationSessionId: "parent-session",
    navigationNodeId: "node-1",
    navigationEventId: null,
    archived: false,
    pinned: false,
    version: 1,
    createdAt: `2026-05-26T00:00:0${positionKey}.000Z`,
    updatedAt: "2026-05-26T00:00:00.000Z",
  };
}

describe("buildTaskTreeRows", () => {
  it("tracks depth, last-child state, and ancestor continuation lines", () => {
    const rows = buildTaskTreeRows([
      task("root-a", null, 1),
      task("child-a1", "root-a", 1),
      task("grandchild-a1", "child-a1", 1),
      task("child-a2", "root-a", 2),
      task("root-b", null, 2),
    ]);

    expect(rows.map((row) => ({
      id: row.task.id,
      depth: row.depth,
      isLast: row.isLast,
      ancestorLast: row.ancestorLast,
      hasChildren: row.hasChildren,
    }))).toEqual([
      { id: "root-a", depth: 0, isLast: false, ancestorLast: [], hasChildren: true },
      { id: "child-a1", depth: 1, isLast: false, ancestorLast: [false], hasChildren: true },
      {
        id: "grandchild-a1",
        depth: 2,
        isLast: true,
        ancestorLast: [false, false],
        hasChildren: false,
      },
      { id: "child-a2", depth: 1, isLast: true, ancestorLast: [false], hasChildren: false },
      { id: "root-b", depth: 0, isLast: true, ancestorLast: [], hasChildren: false },
    ]);
  });

  it("sorts only inside each sibling group: pinned, active, held, completed, then updated desc", () => {
    const active = { ...task("active", null, 1), status: "in_progress" as const };
    const pinned = { ...task("pinned", null, 4), pinned: true };
    const held = { ...task("held", null, 2), status: "blocked" as const };
    const done = { ...task("done", null, 3), status: "verified_done" as const };
    const child = { ...task("child", "done", 1), pinned: true };

    const rows = buildTaskTreeRows([done, held, active, pinned, child]);

    expect(rows.map((row) => row.task.id)).toEqual([
      "pinned",
      "active",
      "held",
      "done",
      "child",
    ]);
  });

  it("can hide completed tasks without collapsing every depth into a global sort", () => {
    const rows = buildTaskTreeRows(
      [
        { ...task("root", null, 1), status: "in_progress" as const },
        { ...task("done-child", "root", 1), status: "verified_done" as const },
        task("active-child", "root", 2),
      ],
      { hideCompleted: true },
    );

    expect(rows.map((row) => row.task.id)).toEqual(["root", "active-child"]);
    expect(rows[1].depth).toBe(1);
    expect(rows[0].hasChildren).toBe(true);
    expect(rows[1].hasChildren).toBe(false);
  });

  it("keeps agent_done visible when hiding user-completed tasks", () => {
    const rows = buildTaskTreeRows(
      [
        { ...task("root", null, 1), status: "in_progress" as const },
        { ...task("agent-done-child", "root", 1), status: "agent_done" as const },
        { ...task("verified-child", "root", 2), status: "verified_done" as const },
      ],
      { hideCompleted: true },
    );

    expect(rows.map((row) => row.task.id)).toEqual(["root", "agent-done-child"]);
    expect(rows[1].depth).toBe(1);
  });

  it("uses descendant updates when sorting ancestor sibling groups", () => {
    const quietParent = {
      ...task("quiet-parent", null, 1),
      updatedAt: "2026-05-26T00:00:10.000Z",
    };
    const activeParent = {
      ...task("active-parent", null, 2),
      updatedAt: "2026-05-26T00:00:00.000Z",
    };
    const activeChild = {
      ...task("active-child", "active-parent", 1),
      updatedAt: "2026-05-26T00:00:20.000Z",
    };

    const rows = buildTaskTreeRows([quietParent, activeParent, activeChild]);

    expect(rows.map((row) => row.task.id)).toEqual([
      "active-parent",
      "active-child",
      "quiet-parent",
    ]);
  });
});

describe("Task status menu options", () => {
  it("includes the user verified completion status", () => {
    expect(STATUS_OPTIONS).toContain("verified_done");
    expect(STATUS_META.verified_done.label).toBe("완료");
  });
});

describe("buildTaskStreamUrl", () => {
  it("adds reconnect coordinates only when present", () => {
    expect(buildTaskStreamUrl()).toBe("/api/tasks/stream");
    expect(buildTaskStreamUrl("42", "orch-A")).toBe(
      "/api/tasks/stream?lastEventId=42&instanceId=orch-A",
    );
  });
});

describe("resolveTaskTreeHeaderAction", () => {
  it("uses the New Session affordance when a callback is provided", () => {
    expect(resolveTaskTreeHeaderAction(() => undefined)).toEqual({
      visible: true,
      label: "New",
      title: "New session",
    });
  });

  it("does not expose a refresh action", () => {
    expect(resolveTaskTreeHeaderAction(undefined)).toEqual({ visible: false });
  });
});
