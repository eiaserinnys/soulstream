import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@seosoyoung/soul-ui";

import {
  buildSuccessionCreateOptions,
  resolveRunAssignmentDefaults,
} from "./session-succession-model";

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
