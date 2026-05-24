import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, beforeEach, afterAll, beforeAll } from "vitest";
import type { NodeRegister } from "@soulstream/wire-schema";

import { AgentRegistry } from "../src/agent_registry.js";
import {
  buildRegistrationMsg,
  encodePortrait,
  _resetPortraitCacheForTest,
} from "../src/upstream/registration.js";

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
  beforeEach(() => {
    _resetPortraitCacheForTest();
  });

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
    // portrait_path 미설정 — portrait_url=""·portrait_b64 미박힘 (Python 정본 graceful 정합)
    expect(msg.agents).toEqual([
      {
        id: "codex-default",
        name: "Codex Default",
        backend: "codex",
        portrait_url: "",
      },
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

  it("복수 backend mix를 agents.yaml 정본 그대로 node_register에 광고", () => {
    const msg = buildRegistrationMsg({
      nodeId: "x",
      host: "h",
      port: 1,
      userName: "",
      agentRegistry: new AgentRegistry([codexAgent, claudeAgent]),
    });
    expect(msg.capabilities).toEqual({ max_concurrent: 2 });
    expect((msg.supported_backends ?? []).slice().sort()).toEqual(["claude", "codex"]);
    expect(msg.agents?.map((a) => [a.id, a.name, a.backend])).toEqual([
      ["codex-default", "Codex Default", "codex"],
      ["roselin", "로젤린", "claude"],
    ]);
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

  it("userName과 userPortraitPath가 있으면 user portrait_b64까지 광고", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "registration-user-portrait-"));
    const userPortraitPath = join(tmpDir, "user.png");
    const userPortraitBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x02]);
    writeFileSync(userPortraitPath, userPortraitBytes);
    try {
      const msg = buildRegistrationMsg({
        nodeId: "eias-shopping-ts",
        host: "127.0.0.1",
        port: 4205,
        userName: "김주복",
        userPortraitPath,
        agentRegistry: new AgentRegistry([codexAgent]),
      });

      expect(msg.user).toEqual({
        name: "김주복",
        hasPortrait: true,
        portrait_b64: userPortraitBytes.toString("base64"),
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("user portrait read 실패 시 hasPortrait=false로 광고", () => {
    const msg = buildRegistrationMsg({
      nodeId: "eias-shopping-ts",
      host: "127.0.0.1",
      port: 4205,
      userName: "김주복",
      userPortraitPath: "/nonexistent/user.png",
      agentRegistry: new AgentRegistry([codexAgent]),
    });

    expect(msg.user).toEqual({ name: "김주복", hasPortrait: false });
  });
});

describe("buildRegistrationMsg — portrait wire (Python adapter.py:212-233 정본 정합)", () => {
  let tmpDir: string;
  let portraitPath: string;
  const portraitBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x01]);
  const expectedB64 = portraitBytes.toString("base64");

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "registration-portrait-"));
    portraitPath = join(tmpDir, "portrait.png");
    writeFileSync(portraitPath, portraitBytes);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    _resetPortraitCacheForTest();
  });

  it("portrait_path 설정 → portrait_url + portrait_b64 둘 다 박힘", () => {
    const msg = buildRegistrationMsg({
      nodeId: "eiaserinnys-ts",
      host: "h",
      port: 1,
      userName: "",
      agentRegistry: new AgentRegistry([
        { ...codexAgent, portrait_path: portraitPath },
      ]),
    });
    expect(msg.agents).toEqual([
      {
        id: "codex-default",
        name: "Codex Default",
        backend: "codex",
        portrait_url: "/api/agents/codex-default/portrait",
        portrait_b64: expectedB64,
      },
    ]);
  });

  it("portrait_path 미설정 → portrait_url='' + portrait_b64 키 미박힘", () => {
    const msg = buildRegistrationMsg({
      nodeId: "x",
      host: "h",
      port: 1,
      userName: "",
      agentRegistry: new AgentRegistry([codexAgent]),
    });
    const entry = msg.agents?.[0] as Record<string, unknown>;
    expect(entry.portrait_url).toBe("");
    expect(entry.portrait_b64).toBeUndefined();
  });

  it("portrait_path 설정 + 파일 read 실패(존재하지 않음) → portrait_url은 유지, portrait_b64 미박힘", () => {
    const msg = buildRegistrationMsg({
      nodeId: "x",
      host: "h",
      port: 1,
      userName: "",
      agentRegistry: new AgentRegistry([
        { ...codexAgent, portrait_path: "/nonexistent/path/missing.png" },
      ]),
    });
    const entry = msg.agents?.[0] as Record<string, unknown>;
    expect(entry.portrait_url).toBe("/api/agents/codex-default/portrait");
    expect(entry.portrait_b64).toBeUndefined();
  });

  it("portrait read 실패 시 logger.warn 통지 (silent fallback 방지, design-principles §4·§8)", async () => {
    const { default: pino } = await import("pino");
    const calls: Array<{ obj: object; msg?: string }> = [];
    const logger = pino({ level: "warn" });
    logger.warn = ((obj: unknown, msg?: string) => {
      if (typeof obj === "object" && obj !== null) {
        calls.push({ obj: obj as object, msg });
      }
    }) as typeof logger.warn;

    buildRegistrationMsg({
      nodeId: "x",
      host: "h",
      port: 1,
      userName: "",
      agentRegistry: new AgentRegistry([
        { ...codexAgent, portrait_path: "/nonexistent/missing.png" },
      ]),
      logger,
    });

    expect(calls.length).toBeGreaterThanOrEqual(1);
    const warned = calls.find((c) => c.msg?.includes("portrait read failed"));
    expect(warned).toBeDefined();
    expect((warned!.obj as { path: string }).path).toBe("/nonexistent/missing.png");
  });

  it("logger 미주입 시에도 silent fallback (legacy 호출자 호환)", () => {
    // logger 옵션 없이 호출 — throw 없이 graceful null 처리
    const msg = buildRegistrationMsg({
      nodeId: "x",
      host: "h",
      port: 1,
      userName: "",
      agentRegistry: new AgentRegistry([
        { ...codexAgent, portrait_path: "/nonexistent/missing.png" },
      ]),
    });
    const entry = msg.agents?.[0] as Record<string, unknown>;
    expect(entry.portrait_b64).toBeUndefined();
  });

  it("encodePortrait 캐시 — 같은 경로 두 번 호출 시 readFileSync 1회만 (성능)", () => {
    // 캐시 격리 (beforeEach)
    const first = encodePortrait(portraitPath);
    expect(first).toBe(expectedB64);
    // 파일을 *삭제*해도 캐시 반환 — readFileSync 호출 없음 증명
    rmSync(portraitPath);
    const second = encodePortrait(portraitPath);
    expect(second).toBe(expectedB64);
    // 복원 (다른 케이스를 위해)
    writeFileSync(portraitPath, portraitBytes);
  });

  it("여러 agent 동시 광고 — 각각 자기 portrait_b64", () => {
    const altPath = join(tmpDir, "other.png");
    const altBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    writeFileSync(altPath, altBytes);
    try {
      const msg = buildRegistrationMsg({
        nodeId: "x",
        host: "h",
        port: 1,
        userName: "",
        agentRegistry: new AgentRegistry([
          { ...codexAgent, portrait_path: portraitPath },
          { ...claudeAgent, portrait_path: altPath },
        ]),
      });
      const codex = msg.agents?.find((a) => a.id === "codex-default") as Record<string, unknown>;
      const claude = msg.agents?.find((a) => a.id === "roselin") as Record<string, unknown>;
      expect(codex.portrait_b64).toBe(expectedB64);
      expect(claude.portrait_b64).toBe(altBytes.toString("base64"));
      expect(codex.portrait_url).toBe("/api/agents/codex-default/portrait");
      expect(claude.portrait_url).toBe("/api/agents/roselin/portrait");
    } finally {
      rmSync(altPath, { force: true });
    }
  });
});
