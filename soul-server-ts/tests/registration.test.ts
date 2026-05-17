import { describe, expect, it } from "vitest";
import type { NodeRegister } from "@soulstream/wire-schema";

import { AgentRegistry } from "../src/agent_registry.js";
import { buildRegistrationMsg } from "../src/upstream/registration.js";

const codexAgent = {
  id: "codex-default",
  name: "Codex Default",
  backend: "codex" as const,
  workspace_dir: "/tmp/codex-default",
};

const claudeAgent = {
  id: "roselin",
  name: "로젤린",
  backend: "claude" as const,
  workspace_dir: "/tmp/roselin",
};

describe("buildRegistrationMsg (Phase B-3 yaml-driven)", () => {
  it("agentRegistry 결과로 agents·supported_backends·max_concurrent 채움", () => {
    const registry = new AgentRegistry([codexAgent]);
    const msg = buildRegistrationMsg({
      nodeId: "eias-shopping-ts",
      host: "127.0.0.1",
      port: 4205,
      userName: "",
      agentRegistry: registry,
    });

    // 타입 차원 검증
    const _typed: NodeRegister = msg;
    void _typed;

    expect(msg.type).toBe("node_register");
    expect(msg.node_id).toBe("eias-shopping-ts");
    expect(msg.host).toBe("127.0.0.1");
    expect(msg.port).toBe(4205);
    expect(msg.capabilities).toEqual({ max_concurrent: 1 });
    expect(msg.supported_backends).toEqual(["codex"]);
    expect(msg.agents).toEqual([
      { id: "codex-default", name: "Codex Default", backend: "codex" },
    ]);
    expect(msg.user).toBeUndefined();
  });

  it("빈 registry → agents=[], max_concurrent=0, supported_backends=[]", () => {
    const msg = buildRegistrationMsg({
      nodeId: "x",
      host: "h",
      port: 1,
      userName: "",
      agentRegistry: new AgentRegistry([]),
    });
    expect(msg.agents).toEqual([]);
    expect(msg.capabilities).toEqual({ max_concurrent: 0 });
    expect(msg.supported_backends).toEqual([]);
  });

  it("복수 backend mix → supported_backends 중복 제거 + max_concurrent=count", () => {
    const msg = buildRegistrationMsg({
      nodeId: "x",
      host: "h",
      port: 1,
      userName: "",
      agentRegistry: new AgentRegistry([codexAgent, claudeAgent]),
    });
    expect(msg.capabilities).toEqual({ max_concurrent: 2 });
    expect((msg.supported_backends ?? []).slice().sort()).toEqual(["claude", "codex"]);
    expect(msg.agents).toHaveLength(2);
  });

  it("userName이 있으면 user 광고", () => {
    const msg = buildRegistrationMsg({
      nodeId: "eias-shopping-ts",
      host: "127.0.0.1",
      port: 4205,
      userName: "김주복",
      agentRegistry: new AgentRegistry([codexAgent]),
    });
    expect(msg.user).toEqual({ name: "김주복", hasPortrait: false });
  });

  it("agents 광고에는 portrait_url·workspace_dir 등 내부 필드 미포함 (wire 최소)", () => {
    const msg = buildRegistrationMsg({
      nodeId: "x",
      host: "h",
      port: 1,
      userName: "",
      agentRegistry: new AgentRegistry([
        { ...codexAgent, portrait_path: "/var/x.png", max_turns: 10 },
      ]),
    });
    expect(msg.agents).toEqual([
      { id: "codex-default", name: "Codex Default", backend: "codex" },
    ]);
  });
});
