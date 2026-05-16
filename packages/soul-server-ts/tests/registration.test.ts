import { describe, expect, it } from "vitest";
import type { NodeRegister } from "@soulstream/wire-schema";

import { buildRegistrationMsg } from "../src/upstream/registration.js";

describe("buildRegistrationMsg", () => {
  it("필수 필드를 정확히 채운다 (NodeRegister wire-schema 정본 호환)", () => {
    const msg = buildRegistrationMsg({
      nodeId: "eias-shopping-ts",
      host: "127.0.0.1",
      port: 4205,
      userName: "",
    });

    // 타입 차원 검증 — NodeRegister 타입에 satisfies
    const _typed: NodeRegister = msg;
    void _typed;

    expect(msg.type).toBe("node_register");
    expect(msg.node_id).toBe("eias-shopping-ts");
    expect(msg.host).toBe("127.0.0.1");
    expect(msg.port).toBe(4205);
    expect(msg.capabilities).toEqual({ max_concurrent: 0 });
    expect(msg.supported_backends).toEqual(["codex"]);
    // Phase B-2: 임시 codex-default agent 광고. B-3에서 agent_registry yaml 정본으로 교체.
    expect(msg.agents).toEqual([
      { id: "codex-default", name: "Codex Default", backend: "codex" },
    ]);
    expect(msg.user).toBeUndefined();
  });

  it("agents 배열에 codex-default가 광고됨 (Phase B-2 R6)", () => {
    const msg = buildRegistrationMsg({
      nodeId: "any",
      host: "any",
      port: 0,
      userName: "",
    });
    expect(msg.agents).toHaveLength(1);
    expect(msg.agents?.[0]).toEqual({
      id: "codex-default",
      name: "Codex Default",
      backend: "codex",
    });
  });

  it("userName이 있으면 user 광고", () => {
    const msg = buildRegistrationMsg({
      nodeId: "eias-shopping-ts",
      host: "127.0.0.1",
      port: 4205,
      userName: "김주복",
    });
    expect(msg.user).toEqual({ name: "김주복", hasPortrait: false });
  });

  it("userName이 빈 문자열이면 user 키 부재 (Python adapter.py L237 등가)", () => {
    const msg = buildRegistrationMsg({
      nodeId: "x",
      host: "h",
      port: 1,
      userName: "",
    });
    expect(msg.user).toBeUndefined();
  });

  it("supported_backends는 항상 [codex] — Codex 전담 노드", () => {
    const msg = buildRegistrationMsg({
      nodeId: "any",
      host: "any",
      port: 0,
      userName: "",
    });
    expect(msg.supported_backends).toEqual(["codex"]);
  });
});
