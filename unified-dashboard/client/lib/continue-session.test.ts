import { describe, expect, it } from "vitest";
import type { CatalogState, SessionSummary } from "@seosoyoung/soul-ui";

import {
  resolveContinueSessionTarget,
} from "./continue-session";

const catalog: CatalogState = {
  folders: [],
  sessions: {
    "session-a": { folderId: "folder-from-catalog", displayName: null },
  },
};

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    agentSessionId: "session-a",
    status: "completed",
    eventCount: 3,
    nodeId: "node-a",
    agentId: "roselin_codex",
    agentName: "Roselin",
    agentPortraitUrl: "/portrait",
    backend: "codex",
    folderId: "folder-a",
    ...overrides,
  };
}

describe("continue-session helpers", () => {
  it("inherits the same node, agent, and folder from the original session", () => {
    expect(resolveContinueSessionTarget({
      session: session(),
      catalog,
    })).toMatchObject({
      disabledReason: null,
      nodeId: "node-a",
      agentId: "roselin_codex",
      folderId: "folder-a",
      agentName: "Roselin",
      agentPortraitUrl: "/portrait",
      backend: "codex",
    });
  });

  it("uses catalog folder assignment when the summary has no folder id", () => {
    expect(resolveContinueSessionTarget({
      session: session({ folderId: undefined }),
      catalog,
    })?.folderId).toBe("folder-from-catalog");
  });

  it("disables continuation when no same-agent target can be resolved", () => {
    expect(resolveContinueSessionTarget({
      session: session({ agentId: undefined, agentName: undefined }),
      catalog,
    })).toMatchObject({
      disabledReason: "이 세션에는 에이전트 정보가 없어 이어서 시작할 수 없습니다.",
    });
  });

  it("disables orchestrator continuation when the source node is missing", () => {
    expect(resolveContinueSessionTarget({
      session: session({ nodeId: undefined }),
      catalog,
    })).toMatchObject({
      disabledReason: "이 세션에는 노드 정보가 없어 이어서 시작할 수 없습니다.",
    });
  });
});
