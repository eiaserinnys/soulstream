import { describe, expect, it } from "vitest";
import type { CatalogState, DashboardAgentConfig, SessionSummary } from "@seosoyoung/soul-ui";

import {
  buildContinueSessionPrompt,
  resolveContinueSessionTarget,
} from "./continue-session";

const catalog: CatalogState = {
  folders: [],
  sessions: {
    "session-a": { folderId: "folder-from-catalog", displayName: null },
  },
};

const agent: DashboardAgentConfig = {
  id: "roselin_codex",
  name: "Roselin",
  hasPortrait: true,
  portraitUrl: "/portrait",
  backend: "codex",
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
  it("builds the prompt with the source session id", () => {
    expect(buildContinueSessionPrompt("session-a")).toBe(
      "세션 session-a의 기록을 조회해 맥락을 파악한 뒤, 사용자의 지시를 대기해주세요.",
    );
  });

  it("inherits the same node, agent, and folder from the original session", () => {
    expect(resolveContinueSessionTarget({
      session: session(),
      catalog,
      agents: [agent],
      mode: "orchestrator",
      localNodeId: null,
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
      agents: [agent],
      mode: "orchestrator",
      localNodeId: null,
    })?.folderId).toBe("folder-from-catalog");
  });

  it("falls back to the single configured agent only in single-node mode", () => {
    expect(resolveContinueSessionTarget({
      session: session({ agentId: undefined, agentName: undefined }),
      catalog,
      agents: [agent],
      mode: "single",
      localNodeId: "node-local",
    })).toMatchObject({
      disabledReason: null,
      nodeId: "node-a",
      agentId: "roselin_codex",
      agentName: "Roselin",
    });
  });

  it("disables continuation when no same-agent target can be resolved", () => {
    expect(resolveContinueSessionTarget({
      session: session({ agentId: undefined, agentName: undefined }),
      catalog,
      agents: [],
      mode: "orchestrator",
      localNodeId: null,
    })).toMatchObject({
      disabledReason: "이 세션에는 에이전트 정보가 없어 이어서 시작할 수 없습니다.",
    });
  });

  it("disables orchestrator continuation when the source node is missing", () => {
    expect(resolveContinueSessionTarget({
      session: session({ nodeId: undefined }),
      catalog,
      agents: [agent],
      mode: "orchestrator",
      localNodeId: null,
    })).toMatchObject({
      disabledReason: "이 세션에는 노드 정보가 없어 이어서 시작할 수 없습니다.",
    });
  });
});
