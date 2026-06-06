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

  it("model은 optional agent-level Codex 모델 override로 파싱한다", () => {
    const parsed = AgentProfileSchema.parse({
      id: "zombie-labyrinth-bot",
      name: "Zombie Labyrinth Bot",
      backend: "codex",
      workspace_dir: "/tmp/zombie-labyrinth-bot",
      model: "gpt-5.3-codex-spark",
    });

    expect(parsed.model).toBe("gpt-5.3-codex-spark");
  });

  it("model 빈 문자열은 거부한다", () => {
    expect(() =>
      AgentProfileSchema.parse({
        id: "zombie-labyrinth-bot",
        name: "Zombie Labyrinth Bot",
        backend: "codex",
        workspace_dir: "/tmp/zombie-labyrinth-bot",
        model: "",
      }),
    ).toThrow(ZodError);
  });

  it("atom_contexts는 node_id/depth/titles_only를 파싱한다", () => {
    const parsed = AgentProfileSchema.parse({
      id: "a",
      name: "A",
      backend: "codex",
      workspace_dir: "/tmp/a",
      atom_contexts: [
        {
          node_id: "11111111-2222-3333-4444-555555555555",
          depth: 2,
          titles_only: true,
        },
      ],
    });
    expect(parsed.atom_contexts).toEqual([
      {
        node_id: "11111111-2222-3333-4444-555555555555",
        depth: 2,
        titles_only: true,
      },
    ]);
  });

  it("atom_contexts depth/titles_only 기본값", () => {
    const parsed = AgentProfileSchema.parse({
      id: "a",
      name: "A",
      backend: "codex",
      workspace_dir: "/tmp/a",
      atom_contexts: [
        { node_id: "11111111-2222-3333-4444-555555555555" },
      ],
    });
    expect(parsed.atom_contexts).toEqual([
      {
        node_id: "11111111-2222-3333-4444-555555555555",
        depth: 3,
        titles_only: false,
      },
    ]);
  });

  it("atom_contexts node_id가 UUID가 아니면 거부", () => {
    expect(() =>
      AgentProfileSchema.parse({
        id: "a",
        name: "A",
        backend: "codex",
        workspace_dir: "/tmp/a",
        atom_contexts: [{ node_id: "not-a-uuid" }],
      }),
    ).toThrow(ZodError);
  });

  it("openai-agents profile은 provider, hosted_tools, mcp_servers를 agents_sdk 아래에서 파싱", () => {
    const parsed = AgentProfileSchema.parse({
      id: "agents-research",
      name: "Agents Research",
      backend: "openai-agents",
      workspace_dir: "/tmp/agents",
      agents_sdk: {
        entry_agent: "triage",
        provider: {
          type: "openai",
          api_key_env: "OPENAI_API_KEY",
          use_responses: true,
          strict_feature_validation: true,
        },
        agents: [
          {
            id: "triage",
            name: "Triage",
            instructions: "Route work.",
            hosted_tools: [
              {
                type: "web_search",
                name: "web_search",
                search_context_size: "low",
                external_web_access: true,
              },
              {
                type: "file_search",
                vector_store_ids: ["vs_123"],
                include_search_results: true,
              },
              {
                type: "hosted_mcp",
                server_label: "docs",
                server_url: "https://mcp.example.com",
                allowed_tools: ["search_docs"],
                require_approval: "always",
              },
            ],
            mcp_servers: [
              {
                type: "stdio",
                name: "local-docs",
                command: "node",
                args: ["server.js"],
                cache_tools_list: true,
              },
              {
                type: "streamable_http",
                name: "remote-docs",
                url: "https://mcp.example.com/mcp",
                headers: { Authorization: "Bearer test" },
              },
            ],
          },
        ],
      },
    });

    expect(parsed.agents_sdk?.provider?.type).toBe("openai");
    expect(parsed.agents_sdk?.agents[0]?.hosted_tools).toHaveLength(3);
    expect(parsed.agents_sdk?.agents[0]?.mcp_servers?.[1]).toMatchObject({
      type: "streamable_http",
      name: "remote-docs",
    });
  });

  it("agent profile은 mcp_profile 참조를 기존 inline agents_sdk와 함께 파싱", () => {
    const parsed = AgentProfileSchema.parse({
      id: "agents-research",
      name: "Agents Research",
      backend: "openai-agents",
      workspace_dir: "/tmp/agents",
      mcp_profile: "research-defaults",
      agents_sdk: {
        entry_agent: "triage",
        agents: [
          {
            id: "triage",
            name: "Triage",
            instructions: "Route work.",
            hosted_tools: [{ type: "web_search" }],
          },
        ],
      },
    });

    expect(parsed.mcp_profile).toBe("research-defaults");
    expect(parsed.agents_sdk?.agents[0]?.hosted_tools).toEqual([
      { type: "web_search" },
    ]);
  });

  it("file_search hosted tool은 vector_store_ids가 없으면 거부", () => {
    expect(() =>
      AgentProfileSchema.parse({
        id: "agents-research",
        name: "Agents Research",
        backend: "openai-agents",
        workspace_dir: "/tmp/agents",
        agents_sdk: {
          entry_agent: "triage",
          agents: [
            {
              id: "triage",
              name: "Triage",
              instructions: "Route work.",
              hosted_tools: [{ type: "file_search" }],
            },
          ],
        },
      }),
    ).toThrow(ZodError);
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
    model: gpt-5.3-codex-spark
    allowed_tools:
      - bash
      - read
`;
    withTempYaml(yaml, (p) => {
      const r = loadAgentRegistry(p);
      const a = r.get("a");
      expect(a?.max_turns).toBe(50);
      expect(a?.model).toBe("gpt-5.3-codex-spark");
      expect(a?.allowed_tools).toEqual(["bash", "read"]);
    });
  });

  it("atom_contexts 로딩", () => {
    const yaml = `
agents:
  - id: a
    name: A
    backend: codex
    workspace_dir: /tmp/a
    atom_contexts:
      - node_id: 11111111-2222-3333-4444-555555555555
        depth: 2
        titles_only: true
`;
    withTempYaml(yaml, (p) => {
      const r = loadAgentRegistry(p);
      expect(r.get("a")?.atom_contexts).toEqual([
        {
          node_id: "11111111-2222-3333-4444-555555555555",
          depth: 2,
          titles_only: true,
        },
      ]);
    });
  });
});
