import { describe, expect, it } from "vitest";

import {
  buildAgentCallerInfo,
  buildCallerInfoFromCallerSession,
} from "../src/caller_info.js";
import type { CallerInfo } from "../src/task/task_models.js";

describe("buildAgentCallerInfo", () => {
  it("source가 'agent'로 고정된다", () => {
    const info = buildAgentCallerInfo({
      agentNode: "node-1",
      agentId: "agent-1",
      agentName: "에이전트",
    });
    expect(info.source).toBe("agent");
  });

  it("agent_node를 항상 그대로 채운다", () => {
    const info = buildAgentCallerInfo({
      agentNode: "eiaserinnys",
      agentId: null,
      agentName: null,
    });
    expect(info.agent_node).toBe("eiaserinnys");
  });

  it("agent_id/agent_name이 null이면 builder가 undefined로 변환 (JSON.stringify에서 키 omit)", () => {
    const info = buildAgentCallerInfo({
      agentNode: "node-1",
      agentId: null,
      agentName: null,
    });
    expect(info.agent_id).toBeUndefined();
    expect(info.agent_name).toBeUndefined();
  });

  it("display_name = agent_name, user_id = agent_id (v1 promote)", () => {
    const info = buildAgentCallerInfo({
      agentNode: "node-1",
      agentId: "agent-1",
      agentName: "에이전트",
    });
    expect(info.display_name).toBe("에이전트");
    expect(info.user_id).toBe("agent-1");
  });

  it("portraitPath와 agentId가 모두 truthy면 avatar_url 부여", () => {
    const info = buildAgentCallerInfo({
      agentNode: "eiaserinnys",
      agentId: "roselin",
      agentName: "로젤린",
      portraitPath: "/some/path.png",
    });
    expect(info.avatar_url).toBe(
      "/api/nodes/eiaserinnys/agents/roselin/portrait",
    );
  });

  it("portraitPath 누락 → avatar_url undefined", () => {
    const info = buildAgentCallerInfo({
      agentNode: "eiaserinnys",
      agentId: "roselin",
      agentName: "로젤린",
    });
    expect(info.avatar_url).toBeUndefined();
  });

  it("agentId null + portraitPath 있어도 avatar_url undefined (Python 정합 — None 값 자리에 키 자체는 graceful)", () => {
    const info = buildAgentCallerInfo({
      agentNode: "eiaserinnys",
      agentId: null,
      agentName: "로젤린",
      portraitPath: "/some/path.png",
    });
    expect(info.avatar_url).toBeUndefined();
  });

  it("결과는 CallerInfo type으로 widening 가능 (정본 단일 표면 검증)", () => {
    const info = buildAgentCallerInfo({
      agentNode: "node-1",
      agentId: "agent-1",
      agentName: "에이전트",
    });
    // AgentCallerInfo extends CallerInfo이므로 컴파일 시 호환.
    const widened: CallerInfo = info;
    expect(widened.source).toBe("agent");
  });
});

describe("buildCallerInfoFromCallerSession (code-reviewer P2-1 정정)", () => {
  it("taskManager에 task 부재 → agent_id/agent_name 모두 undefined", () => {
    const info = buildCallerInfoFromCallerSession(
      {
        nodeId: "n1",
        taskManager: { getTask: () => undefined },
        agentRegistry: { get: () => undefined },
      },
      "missing-session",
    );
    expect(info.source).toBe("agent");
    expect(info.agent_node).toBe("n1");
    expect(info.agent_id).toBeUndefined();
    expect(info.agent_name).toBeUndefined();
  });

  it("taskManager hit + agentRegistry miss → agent_id 있음, agent_name undefined", () => {
    const info = buildCallerInfoFromCallerSession(
      {
        nodeId: "n1",
        taskManager: { getTask: () => ({ profileId: "agent-x" }) },
        agentRegistry: { get: () => undefined },
      },
      "sess-1",
    );
    expect(info.agent_id).toBe("agent-x");
    expect(info.user_id).toBe("agent-x");
    expect(info.agent_name).toBeUndefined();
  });

  it("taskManager + agentRegistry 모두 hit → display_name + avatar_url", () => {
    const info = buildCallerInfoFromCallerSession(
      {
        nodeId: "n1",
        taskManager: { getTask: () => ({ profileId: "agent-x" }) },
        agentRegistry: {
          get: () => ({ name: "에이전트", portrait_path: "/p.png" }),
        },
      },
      "sess-1",
    );
    expect(info.display_name).toBe("에이전트");
    expect(info.avatar_url).toBe("/api/nodes/n1/agents/agent-x/portrait");
  });
});
