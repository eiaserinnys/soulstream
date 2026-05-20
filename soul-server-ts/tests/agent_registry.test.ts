import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";

import {
  AgentProfileSchema,
  AgentRegistry,
  loadAgentRegistry,
} from "../src/agent_registry.js";

function withTempYaml<T>(content: string, fn: (p: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentreg-"));
  const file = path.join(dir, "agents.yaml");
  fs.writeFileSync(file, content, "utf-8");
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("AgentProfileSchema", () => {
  it("필수 키 모두 있으면 통과", () => {
    const parsed = AgentProfileSchema.parse({
      id: "codex-default",
      name: "Codex Default",
      backend: "codex",
      workspace_dir: "/tmp/codex-default",
    });
    expect(parsed.id).toBe("codex-default");
    expect(parsed.backend).toBe("codex");
  });

  it("backend가 claude/codex 외이면 거부", () => {
    expect(() =>
      AgentProfileSchema.parse({
        id: "a",
        name: "A",
        backend: "gemini",
        workspace_dir: "/tmp/a",
      }),
    ).toThrow(ZodError);
  });

  it("optional 필드 (max_turns, allowed_tools, portrait_path) 미지정 시 통과", () => {
    const parsed = AgentProfileSchema.parse({
      id: "a",
      name: "A",
      backend: "codex",
      workspace_dir: "/tmp/a",
    });
    expect(parsed.max_turns).toBeUndefined();
    expect(parsed.allowed_tools).toBeUndefined();
  });

  it("id 빈 문자열 거부", () => {
    expect(() =>
      AgentProfileSchema.parse({
        id: "",
        name: "x",
        backend: "codex",
        workspace_dir: "/tmp/x",
      }),
    ).toThrow(ZodError);
  });
});

describe("AgentRegistry", () => {
  const profile = (id: string, backend: "claude" | "codex" = "codex") => ({
    id,
    name: `Agent ${id}`,
    backend,
    workspace_dir: `/tmp/${id}`,
  });

  it("get/has/list 기본 동작", () => {
    const r = new AgentRegistry([profile("a"), profile("b")]);
    expect(r.has("a")).toBe(true);
    expect(r.has("c")).toBe(false);
    expect(r.get("a")?.id).toBe("a");
    expect(r.get("c")).toBeUndefined();
    expect(r.list()).toHaveLength(2);
  });

  it("중복 id throw", () => {
    expect(() => new AgentRegistry([profile("a"), profile("a")])).toThrow(
      /Duplicate agent id/,
    );
  });

  it("supportedBackends 중복 제거", () => {
    const r = new AgentRegistry([
      profile("a", "codex"),
      profile("b", "codex"),
      profile("c", "claude"),
    ]);
    expect(r.supportedBackends().sort()).toEqual(["claude", "codex"]);
  });

  it("빈 profiles → 빈 backend 배열", () => {
    const r = new AgentRegistry([]);
    expect(r.list()).toEqual([]);
    expect(r.supportedBackends()).toEqual([]);
  });

  it("같은 display name이어도 id/backend가 다르면 별도 profile로 보존", () => {
    const r = new AgentRegistry([
      { ...profile("codex-roselin", "codex"), name: "로젤린" },
      { ...profile("claude-roselin", "claude"), name: "로젤린" },
    ]);

    expect(r.list()).toHaveLength(2);
    expect(r.get("codex-roselin")?.backend).toBe("codex");
    expect(r.get("claude-roselin")?.backend).toBe("claude");
  });

});

describe("loadAgentRegistry", () => {
  it("정상 yaml 로딩", () => {
    const yaml = `
agents:
  - id: codex-default
    name: Codex Default
    backend: codex
    workspace_dir: /tmp/codex-default
`;
    withTempYaml(yaml, (p) => {
      const r = loadAgentRegistry(p);
      expect(r.has("codex-default")).toBe(true);
      expect(r.get("codex-default")?.name).toBe("Codex Default");
    });
  });

  it("빈 yaml → 빈 registry", () => {
    withTempYaml("", (p) => {
      const r = loadAgentRegistry(p);
      expect(r.list()).toEqual([]);
    });
  });

  it("agents: [] 명시도 정상", () => {
    withTempYaml("agents: []\n", (p) => {
      expect(loadAgentRegistry(p).list()).toEqual([]);
    });
  });

  it("ENOENT — 파일 부재 시 throw (Haniel 미적용 상태 가드)", () => {
    expect(() => loadAgentRegistry("/nonexistent/agents.yaml")).toThrow(/ENOENT/);
  });

  it("schema 위반 → ZodError", () => {
    const yaml = `agents:\n  - id: a\n    backend: codex\n`;  // name·workspace_dir 누락
    withTempYaml(yaml, (p) => {
      expect(() => loadAgentRegistry(p)).toThrow(ZodError);
    });
  });

  it("중복 id → throw", () => {
    const yaml = `
agents:
  - id: dup
    name: X
    backend: codex
    workspace_dir: /tmp/x
  - id: dup
    name: Y
    backend: codex
    workspace_dir: /tmp/y
`;
    withTempYaml(yaml, (p) => {
      expect(() => loadAgentRegistry(p)).toThrow(/Duplicate agent id/);
    });
  });

  it("optional 필드(max_turns, allowed_tools) 로딩", () => {
    const yaml = `
agents:
  - id: a
    name: A
    backend: codex
    workspace_dir: /tmp/a
    max_turns: 50
    allowed_tools:
      - bash
      - read
`;
    withTempYaml(yaml, (p) => {
      const r = loadAgentRegistry(p);
      const a = r.get("a");
      expect(a?.max_turns).toBe(50);
      expect(a?.allowed_tools).toEqual(["bash", "read"]);
    });
  });
});
