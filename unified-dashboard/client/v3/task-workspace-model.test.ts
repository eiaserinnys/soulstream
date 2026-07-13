import { describe, expect, it } from "vitest";

import type { BlockDto, PageDto } from "@seosoyoung/soul-ui/page";
import type { SessionSummary } from "@seosoyoung/soul-ui";

import {
  DEFAULT_WORKSPACE_SPLIT,
  buildDescriptionMutation,
  buildRunTree,
  clampWorkspaceSplit,
  descriptionMarkdown,
  reduceWorkspaceEscape,
  workspaceSplitForKey,
} from "./task-workspace-model";

describe("task workspace split", () => {
  it("clamps pointer percentages, resets Home, and moves arrow keys by two percent", () => {
    expect(clampWorkspaceSplit(-20)).toBe(25);
    expect(clampWorkspaceSplit(82)).toBe(75);
    expect(clampWorkspaceSplit(44.5)).toBe(44.5);
    expect(workspaceSplitForKey(25, "ArrowLeft")).toBe(25);
    expect(workspaceSplitForKey(60, "ArrowLeft")).toBe(58);
    expect(workspaceSplitForKey(60, "ArrowRight")).toBe(62);
    expect(workspaceSplitForKey(73.5, "ArrowRight")).toBe(75);
    expect(workspaceSplitForKey(31, "Home")).toBe(DEFAULT_WORKSPACE_SPLIT);
    expect(workspaceSplitForKey(60, "Enter")).toBeNull();
  });
});

describe("run tree projection", () => {
  it("numbers container runs chronologically and nests caller descendants", () => {
    const roots = ["run-old", "run-new"];
    const sessions = [
      session("delegate-grandchild", "2026-07-13T11:30:00Z", "delegate-child"),
      session("run-new", "2026-07-13T12:00:00Z"),
      session("delegate-child", "2026-07-13T12:30:00Z", "run-new"),
      session("run-old", "2026-07-13T10:00:00Z"),
      session("unrelated", "2026-07-13T13:00:00Z"),
    ];

    const tree = buildRunTree(roots, sessions);

    expect(tree.map((node) => [node.session.agentSessionId, node.runNumber])).toEqual([
      ["run-new", 2],
      ["run-old", 1],
    ]);
    expect(tree[0]?.children[0]?.session.agentSessionId).toBe("delegate-child");
    expect(tree[0]?.children[0]?.children[0]?.session.agentSessionId).toBe("delegate-grandchild");
    expect(JSON.stringify(tree)).not.toContain("unrelated");
  });
});

describe("description markdown boundary", () => {
  it("round-trips paragraph trees without mutating special blocks or mounts", () => {
    const page = pageDto();
    const blocks = [
      block("paragraph-root", "paragraph", "**목표**"),
      block("check-child", "checklist", "완료 조건", "paragraph-root", { checked: true }),
      block("runbook", "runbook_ref", "", null, { runbookId: "rb-1", primary: true }),
      block("defaults", "session_defaults", "", null, { agentId: "roselin", scope: "run" }),
      block("atom", "atom_ref", "", null, { instance: "atom", nodeId: "node-a" }),
      block("guidance", "guidance", "검수 원칙", null, { enabled: true, scope: "run" }),
      block("mount", "paragraph", "[[설계 문서]]"),
    ];

    const markdown = descriptionMarkdown(page, blocks);
    const mutation = buildDescriptionMutation({
      page,
      blocks,
      markdown: `${markdown}\n\n새 문단`,
      createTempId: (() => { let value = 0; return () => `temp-${++value}`; })(),
    });

    expect(markdown).toContain("**목표**");
    expect(markdown).toContain("- [x] 완료 조건");
    expect(markdown).not.toContain("설계 문서");
    expect(mutation.operations).toContainEqual({ op: "delete_block_subtree", block_id: "paragraph-root" });
    expect(mutation.operations.filter((operation) => operation.op === "delete_block_subtree"))
      .toEqual([{ op: "delete_block_subtree", block_id: "paragraph-root" }]);
    expect(mutation.preservedBlockIds).toEqual(["runbook", "defaults", "atom", "guidance", "mount"]);
  });
});

describe("workspace Escape hierarchy", () => {
  it("returns from chat to the planner before closing a detail-only workspace", () => {
    expect(reduceWorkspaceEscape({ workspaceOpen: true, chatOpen: true })).toEqual({
      workspaceOpen: false,
      chatOpen: false,
      handled: true,
    });
    expect(reduceWorkspaceEscape({ workspaceOpen: true, chatOpen: false })).toEqual({
      workspaceOpen: false,
      chatOpen: false,
      handled: true,
    });
    expect(reduceWorkspaceEscape({ workspaceOpen: false, chatOpen: false })).toEqual({
      workspaceOpen: false,
      chatOpen: false,
      handled: false,
    });
  });
});

function session(id: string, createdAt: string, callerSessionId?: string): SessionSummary {
  return {
    agentSessionId: id,
    status: "completed",
    eventCount: 1,
    createdAt,
    ...(callerSessionId ? { callerSessionId } : {}),
  };
}

function pageDto(): PageDto {
  return {
    id: "task-page",
    title: "업무 제목",
    daily_date: null,
    version: 4,
    archived: false,
    metadata: {},
    created_at: "2026-07-13T10:00:00Z",
    updated_at: "2026-07-13T10:00:00Z",
  };
}

function block(
  id: string,
  blockType: string,
  text: string,
  parentId: string | null = null,
  properties: Record<string, unknown> = {},
): BlockDto {
  return {
    id,
    page_id: "task-page",
    parent_id: parentId,
    position_key: id,
    block_type: blockType,
    text,
    properties,
    collapsed: false,
  };
}
