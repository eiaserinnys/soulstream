import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@seosoyoung/soul-ui";

import {
  buildSuccessionSessionOptions,
  buildSuccessionCreateOptions,
  resolveRunAssignmentDefaults,
} from "./session-succession-model";
import type { RunTreeNode } from "./task-workspace-model";

const pageAnchor = { pageId: "task-page", blockId: "anchor-block", expectedVersion: 8 };

describe("session succession create options", () => {
  it.each([
    [true, true, { pageAnchor, predecessorSessionId: "run-2" }],
    [true, false, { pageAnchor }],
    [false, true, { predecessorSessionId: "run-2" }],
    [false, false, {}],
  ])("maps card=%s and summary=%s to the additive create fields", (inheritCard, inheritSummary, expected) => {
    expect(buildSuccessionCreateOptions({
      inheritCard,
      inheritSummary,
      pageAnchor,
      predecessorSessionId: "run-2",
    })).toEqual(expected);
  });
});

describe("run assignment defaults", () => {
  const currentSession: SessionSummary = {
    agentSessionId: "run-2",
    status: "completed",
    eventCount: 1,
    agentId: "current-agent",
    nodeId: "current-node",
  };

  it("uses resolved page defaults before the current session", () => {
    expect(resolveRunAssignmentDefaults({
      pageDefaults: {
        agentId: "project-agent",
        nodeId: "project-node",
        sourcePageId: "project-page",
        sourceBlockId: "defaults-block",
      },
      currentSession,
    })).toEqual({ agentId: "project-agent", nodeId: "project-node", source: "page-defaults" });
  });

  it("falls back field-by-field to the current session", () => {
    expect(resolveRunAssignmentDefaults({
      pageDefaults: {
        agentId: null,
        nodeId: "project-node",
        sourcePageId: "project-page",
        sourceBlockId: "defaults-block",
      },
      currentSession,
    })).toEqual({ agentId: "current-agent", nodeId: "project-node", source: "page-defaults" });
    expect(resolveRunAssignmentDefaults({ pageDefaults: null, currentSession }))
      .toEqual({ agentId: "current-agent", nodeId: "current-node", source: "current-session" });
  });
});

describe("succession predecessor options", () => {
  it("uses displayName, then lastMessage preview, without exposing UUIDs", () => {
    const tree: RunTreeNode[] = [
      runNode({
        agentSessionId: "550e8400-e29b-41d4-a716-446655440001",
        displayName: "배포 검수 정리",
      }, 3),
      runNode({
        agentSessionId: "550e8400-e29b-41d4-a716-446655440002",
        lastMessage: {
          type: "user_message",
          preview: "  다음 단계는 다크·라이트 캡처를 확인해 주세요.  ",
          timestamp: "2026-07-15T00:00:00Z",
        },
      }, 2),
      runNode({
        agentSessionId: "550e8400-e29b-41d4-a716-446655440003",
      }, 1),
    ];

    const options = buildSuccessionSessionOptions(tree);

    expect(options.map((option) => option.label)).toEqual([
      "배포 검수 정리",
      "다음 단계는 다크·라이트 캡처를 확인해 주세요.",
      "제목 없는 세션",
    ]);
    expect(options.map((option) => option.runNumber)).toEqual([3, 2, 1]);
    expect(options.map((option) => option.label).join(" ")).not.toContain("550e8400");
  });

  it("clamps fallback previews by Unicode code point and excludes unresolved rows", () => {
    const longPreview = "🧭".repeat(90);
    const tree: RunTreeNode[] = [
      runNode({
        agentSessionId: "ready-session",
        lastMessage: {
          type: "user_message",
          preview: longPreview,
          timestamp: "2026-07-15T00:00:00Z",
        },
      }, 2),
      { ...runNode({ agentSessionId: "loading-session" }, 1), loadState: "loading" },
    ];

    const options = buildSuccessionSessionOptions(tree);

    expect(options).toHaveLength(1);
    expect(options[0].label).toMatch(/^🧭+…$/u);
    expect(Array.from(options[0].label).length).toBeLessThanOrEqual(81);
    expect(options[0].label).not.toContain("�");
  });
});

function runNode(
  session: Partial<SessionSummary> & Pick<SessionSummary, "agentSessionId">,
  runNumber: number | null,
): RunTreeNode {
  return {
    session: {
      status: "completed",
      eventCount: 1,
      ...session,
    },
    runNumber,
    loadState: "ready",
    children: [],
  };
}
