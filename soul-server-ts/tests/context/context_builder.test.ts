/**
 * ExecutionContextBuilder 단위 회귀 — Python `service/execution_context_builder.py` 정본 정합.
 */

import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentRegistry, type AgentProfile } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import {
  ExecutionContextBuilder,
  composeFirstTurnPrompt,
} from "../../src/context/context_builder.js";
import type { CogitoContextConfig } from "../../src/context/cogito_context.js";
import type { Task } from "../../src/task/task_models.js";

const silentLogger = pino({ level: "silent" });

const codexAgent: AgentProfile = {
  id: "codex-default",
  name: "Codex Default",
  backend: "codex",
  workspace_dir: "/agent/default",
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-1",
    prompt: "user prompt",
    status: "running",
    profileId: "codex-default",
    createdAt: new Date(),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
    ...overrides,
  };
}

function makeBuilder(
  dbOverrides: Partial<SessionDB> = {},
  registry?: AgentRegistry,
  atomEnabled = false,
  cogito?: CogitoContextConfig,
): ExecutionContextBuilder {
  const getSession = vi.fn().mockResolvedValue(null);
  const getFolderById = vi.fn().mockResolvedValue(null);
  const db = { getSession, getFolderById, ...dbOverrides } as unknown as SessionDB;
  return new ExecutionContextBuilder(
    db,
    registry ?? new AgentRegistry([codexAgent]),
    {
      nodeId: "node-A",
      atom: {
        enabled: atomEnabled,
        serverUrl: atomEnabled ? "https://atom.test" : "",
        apiKey: atomEnabled ? "k" : "",
      },
      ...(cogito ? { cogito } : {}),
    },
    silentLogger,
  );
}

function makeCogitoConfig(
  overrides: Partial<CogitoContextConfig> = {},
): CogitoContextConfig {
  return {
    baseUrl: "https://orch.test",
    headers: { authorization: "Bearer secret-token" },
    timeoutMs: 50,
    maxNodes: 4,
    maxChars: 4000,
    ...overrides,
  };
}

describe("ExecutionContextBuilder.build — 기본 흐름", () => {
  it("folder 없음 → effectiveSystemPrompt undefined, soulstream_item만 combinedContextItems", async () => {
    const cb = makeBuilder();
    const ctx = await cb.build(makeTask(), codexAgent);
    expect(ctx.effectiveSystemPrompt).toBeUndefined();
    expect(ctx.combinedContextItems).toHaveLength(1);
    expect(ctx.combinedContextItems[0].key).toBe("soulstream_session");
  });

  it("folder.folderPrompt 있음 → effectiveSystemPrompt에 prepend", async () => {
    const getSession = vi.fn().mockResolvedValue({ folder_id: "f-1" });
    const getFolderById = vi.fn().mockResolvedValue({
      id: "f-1",
      name: "✨ 소울스트림",
      sort_order: 0,
      settings: { folderPrompt: "폴더 페르소나 지시문" },
    });
    const cb = makeBuilder({ getSession, getFolderById } as Partial<SessionDB>);
    const ctx = await cb.build(makeTask(), codexAgent);
    expect(ctx.effectiveSystemPrompt).toBe("폴더 페르소나 지시문");
    expect(ctx.folderName).toBe("✨ 소울스트림");
  });

  it("folder.folderPrompt + task.systemPrompt → 둘 다 \\n\\n으로 연결", async () => {
    const getSession = vi.fn().mockResolvedValue({ folder_id: "f-1" });
    const getFolderById = vi.fn().mockResolvedValue({
      id: "f-1",
      name: "n",
      sort_order: 0,
      settings: { folderPrompt: "폴더" },
    });
    const cb = makeBuilder({ getSession, getFolderById } as Partial<SessionDB>);
    const ctx = await cb.build(
      makeTask({ systemPrompt: "task system" }),
      codexAgent,
    );
    expect(ctx.effectiveSystemPrompt).toBe("폴더\n\ntask system");
  });

  it("folderPrompt 없고 task.systemPrompt만 있음 → 그대로 반환", async () => {
    const cb = makeBuilder();
    const ctx = await cb.build(
      makeTask({ systemPrompt: "task only" }),
      codexAgent,
    );
    expect(ctx.effectiveSystemPrompt).toBe("task only");
  });

  it("profile.workspace_dir → workingDir 반환, soulstream_item.workspace_dir에 박힘", async () => {
    const profile: AgentProfile = {
      id: "codex-folder",
      name: "Codex Folder",
      backend: "codex",
      workspace_dir: "/profile/path",
    };
    const cb = makeBuilder({}, new AgentRegistry([profile]));
    const ctx = await cb.build(
      makeTask({ profileId: "codex-folder" }),
      profile,
    );
    expect(ctx.workingDir).toBe("/profile/path");
    const item = ctx.combinedContextItems[0];
    expect((item.content as Record<string, unknown>).workspace_dir).toBe("/profile/path");
  });

  it("profile 미발견 → agent.workspace_dir로 폴백", async () => {
    const cb = makeBuilder({}, new AgentRegistry([]));
    const ctx = await cb.build(makeTask({ profileId: "missing" }), codexAgent);
    expect(ctx.workingDir).toBeUndefined();
    const item = ctx.combinedContextItems[0];
    expect((item.content as Record<string, unknown>).workspace_dir).toBe("/agent/default");
  });

  it("callerInfo 운반 → soulstream_item.content.caller_info (R-2 차단)", async () => {
    const cb = makeBuilder();
    const ctx = await cb.build(
      makeTask({ callerInfo: { source: "slack", display_name: "Alice" } }),
      codexAgent,
    );
    const content = ctx.combinedContextItems[0].content as Record<string, unknown>;
    expect(content.caller_info).toEqual({ source: "slack", display_name: "Alice" });
  });

  it("getSession throw → graceful, folder 없는 흐름과 동일", async () => {
    const getSession = vi.fn().mockRejectedValue(new Error("db down"));
    const cb = makeBuilder({ getSession } as Partial<SessionDB>);
    const ctx = await cb.build(makeTask(), codexAgent);
    expect(ctx.effectiveSystemPrompt).toBeUndefined();
    expect(ctx.combinedContextItems).toHaveLength(1);  // soulstream_item만
  });
});

describe("ExecutionContextBuilder.build — atom_context fetch", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn() as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("agent.atom_contexts 있으면 system prompt 맨 앞에 atom markdown 주입", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ markdown: "# agent atom\nbody" }), { status: 200 }),
    );
    const getSession = vi.fn().mockResolvedValue({ folder_id: "f-1" });
    const getFolderById = vi.fn().mockResolvedValue({
      id: "f-1",
      name: "f",
      sort_order: 0,
      settings: { folderPrompt: "folder prompt" },
    });
    const agent: AgentProfile = {
      ...codexAgent,
      atom_contexts: [
        {
          node_id: "11111111-2222-3333-4444-555555555555",
          depth: 2,
          titles_only: true,
        },
      ],
    };
    const cb = makeBuilder(
      { getSession, getFolderById } as Partial<SessionDB>,
      new AgentRegistry([agent]),
      true,
    );
    const ctx = await cb.build(makeTask({ systemPrompt: "task system" }), agent);
    expect(ctx.effectiveSystemPrompt).toContain("# agent atom");
    expect(ctx.effectiveSystemPrompt?.startsWith("# atom 트리 | 드릴다운:")).toBe(true);
    expect(ctx.effectiveSystemPrompt).toContain("\n\nfolder prompt\n\ntask system");
    expect(ctx.combinedContextItems.map((item) => item.key)).toEqual([
      "soulstream_session",
    ]);
  });

  it("folder.settings.atomContextNode 있고 atom 활성 → atom_context item 추가", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ markdown: "## atom node\nbody" }), { status: 200 }),
    );
    const getSession = vi.fn().mockResolvedValue({ folder_id: "f-1" });
    const getFolderById = vi.fn().mockResolvedValue({
      id: "f-1",
      name: "f",
      sort_order: 0,
      settings: {
        atomContextNode: { nodeId: "11111111-2222-3333-4444-555555555555", depth: 2 },
      },
    });
    const cb = makeBuilder({ getSession, getFolderById } as Partial<SessionDB>, undefined, true);
    const ctx = await cb.build(makeTask(), codexAgent);
    expect(ctx.combinedContextItems).toHaveLength(2);  // soulstream + atom
    expect(ctx.combinedContextItems[1].key).toBe("atom_context");
    expect(ctx.combinedContextItems[1].content).toContain("## atom node");
  });

  it("atom 호출 실패 → atom_context 미포함, turn 진행 계속 (graceful)", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("network"));
    const getSession = vi.fn().mockResolvedValue({ folder_id: "f-1" });
    const getFolderById = vi.fn().mockResolvedValue({
      id: "f-1",
      name: "f",
      sort_order: 0,
      settings: {
        atomContextNode: { nodeId: "11111111-2222-3333-4444-555555555555" },
      },
    });
    const cb = makeBuilder({ getSession, getFolderById } as Partial<SessionDB>, undefined, true);
    const ctx = await cb.build(makeTask(), codexAgent);
    expect(ctx.combinedContextItems).toHaveLength(1);  // soulstream만
  });

  it("atomContextNode 설정 없음 → atom 호출 자체 안 함", async () => {
    const fetchSpy = vi.mocked(globalThis.fetch);
    const getSession = vi.fn().mockResolvedValue({ folder_id: "f-1" });
    const getFolderById = vi.fn().mockResolvedValue({
      id: "f-1",
      name: "f",
      sort_order: 0,
      settings: { folderPrompt: "x" },
    });
    const cb = makeBuilder({ getSession, getFolderById } as Partial<SessionDB>, undefined, true);
    await cb.build(makeTask(), codexAgent);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("atom env 비활성 + atomContextNode 있음 → atom 호출 안 함", async () => {
    const fetchSpy = vi.mocked(globalThis.fetch);
    const getSession = vi.fn().mockResolvedValue({ folder_id: "f-1" });
    const getFolderById = vi.fn().mockResolvedValue({
      id: "f-1",
      name: "f",
      sort_order: 0,
      settings: {
        atomContextNode: { nodeId: "11111111-2222-3333-4444-555555555555" },
      },
    });
    const cb = makeBuilder({ getSession, getFolderById } as Partial<SessionDB>, undefined, false);
    const ctx = await cb.build(makeTask(), codexAgent);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ctx.combinedContextItems).toHaveLength(1);
  });

  it("task.contextItems를 soulstream/atom 뒤에 추가", async () => {
    const cb = makeBuilder();
    const attachmentContext = {
      key: "attached_files",
      label: "첨부 파일",
      content: "- /tmp/a.png",
    };
    const ctx = await cb.build(
      makeTask({ contextItems: [attachmentContext] }),
      codexAgent,
    );
    expect(ctx.combinedContextItems.map((item) => item.key)).toEqual([
      "soulstream_session",
      "attached_files",
    ]);
    expect(ctx.combinedContextItems[1]).toEqual(attachmentContext);
  });
});

describe("ExecutionContextBuilder.build — cogito_context fetch", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn() as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("cogito 설정 있음 → soulstream_session과 별도 cogito_context item 추가", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          schema_version: "soulstream.reflect.aggregate.v1",
          kind: "orchestrator_node_brief_aggregate",
          status: "ok",
          node_count: 1,
          nodes: [
            {
              node_id: "node-A",
              status: "ok",
              data: {
                service: "soul-server-ts",
                status: "ok",
                capabilities: [{ name: "cogito" }],
                sections: {
                  runtime: {
                    status: "ok",
                    data: {
                      process: { uptime_seconds: 10 },
                      counts: { active_task_count: 1 },
                      dependencies: { database: { status: "ok" } },
                    },
                  },
                },
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const cb = makeBuilder({}, undefined, false, makeCogitoConfig());

    const ctx = await cb.build(makeTask(), codexAgent);

    expect(ctx.combinedContextItems.map((item) => item.key)).toEqual([
      "soulstream_session",
      "cogito_context",
    ]);
    expect(ctx.combinedContextItems[1]?.content).toMatchObject({
      status: "ok",
      nodes: [
        expect.objectContaining({
          node_id: "node-A",
          runtime: expect.objectContaining({
            dependency_statuses: { database: "ok" },
          }),
        }),
      ],
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://orch.test/cogito/briefs",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("cogito 조회 실패 → warning context로 격리하고 build는 계속", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("network"));
    const cb = makeBuilder({}, undefined, false, makeCogitoConfig());

    const ctx = await cb.build(makeTask(), codexAgent);

    expect(ctx.combinedContextItems.map((item) => item.key)).toEqual([
      "soulstream_session",
      "cogito_context",
    ]);
    expect(ctx.combinedContextItems[1]?.content).toMatchObject({
      status: "unavailable",
      warnings: [
        {
          code: "cogito_context_unavailable",
          message:
            "cogito cluster brief unavailable; startup continues without live cluster context",
        },
      ],
    });
  });
});

describe("composeFirstTurnPrompt — 합성 알고리즘", () => {
  it("systemPrompt + context + userPrompt 합성", () => {
    const out = composeFirstTurnPrompt({
      effectiveSystemPrompt: "SP",
      combinedContextItems: [{ key: "ctx", content: "value" }],
      assembledPrompt: "USER",
    });
    expect(out).toBe(
      "SP\n\n<context>\n<ctx>\nvalue\n</ctx>\n</context>\n\nUSER",
    );
  });

  it("systemPrompt 없음 → context + userPrompt", () => {
    const out = composeFirstTurnPrompt({
      combinedContextItems: [{ key: "c", content: "v" }],
      assembledPrompt: "U",
    });
    expect(out).toBe("<context>\n<c>\nv\n</c>\n</context>\n\nU");
  });

  it("context 없음 → systemPrompt + userPrompt", () => {
    const out = composeFirstTurnPrompt({
      effectiveSystemPrompt: "SP",
      combinedContextItems: [],
      assembledPrompt: "U",
    });
    expect(out).toBe("SP\n\nU");
  });

  it("systemPrompt·context 둘 다 없음 → userPrompt만", () => {
    const out = composeFirstTurnPrompt({
      combinedContextItems: [],
      assembledPrompt: "U",
    });
    expect(out).toBe("U");
  });
});

describe("ExecutionContextBuilder.buildResumeContextItems — Phase A context 정본 진입점", () => {
  // T-2: 첫 턴과 auto-resume이 같은 `buildSoulstreamContextItem` helper를 거치도록
  // ExecutionContextBuilder에 추가된 public method. atom_context·system_prompt 합성은 제외 —
  // soulstream_item만 만든다 (auto-resume은 SDK가 system_prompt를 보유).
  // atom d7a1ad86 정본 둘 안티패턴 차단.

  it("folder 없음 → soulstream_item 1개, folder='(unassigned)'", async () => {
    const cb = makeBuilder();
    const items = await cb.buildResumeContextItems(makeTask(), codexAgent);
    expect(items).toHaveLength(1);
    expect(items[0].key).toBe("soulstream_session");
    const content = items[0].content as Record<string, unknown>;
    expect(content.folder).toBe("(unassigned)");
    expect(content.agent_session_id).toBe("sess-1");
    expect(content.workspace_dir).toBe("/agent/default");
  });

  it("folder 있음 → soulstream_item.content.folder 박힘", async () => {
    const getSession = vi.fn().mockResolvedValue({ folder_id: "f-1" });
    const getFolderById = vi.fn().mockResolvedValue({
      id: "f-1",
      name: "📚 어떤 폴더",
      settings: {},
    });
    const cb = makeBuilder({ getSession, getFolderById });
    const items = await cb.buildResumeContextItems(makeTask(), codexAgent);
    expect(items).toHaveLength(1);
    const content = items[0].content as Record<string, unknown>;
    expect(content.folder).toBe("📚 어떤 폴더");
  });

  it("profile에 workspace_dir 있음 → workspaceDir에 박힘 (agent fallback 안 함)", async () => {
    const cb = makeBuilder(
      {},
      new AgentRegistry([
        {
          id: "codex-default",
          name: "Codex Default",
          backend: "codex",
          workspace_dir: "/profile/dir",
        },
      ]),
    );
    const items = await cb.buildResumeContextItems(makeTask(), codexAgent);
    const content = items[0].content as Record<string, unknown>;
    expect(content.workspace_dir).toBe("/profile/dir");
  });

  it("profile 미발견 → agent.workspace_dir로 폴백", async () => {
    const cb = makeBuilder({}, new AgentRegistry([])); // 빈 registry
    const items = await cb.buildResumeContextItems(makeTask(), codexAgent);
    const content = items[0].content as Record<string, unknown>;
    expect(content.workspace_dir).toBe("/agent/default"); // agent.workspace_dir
  });

  it("첫 턴(build)과 auto-resume(buildResumeContextItems)이 동일 soulstream_item key 반환 (정본 하나 §3)", async () => {
    // T-2 핵심: 두 method가 같은 buildSoulstreamContextItem helper에 의존.
    // 키/형상이 동일함을 검증하여 첫 턴↔resume 시각적 차이 0 (🔵 #9).
    const cb = makeBuilder();
    const firstTurn = await cb.build(makeTask(), codexAgent);
    const resume = await cb.buildResumeContextItems(makeTask(), codexAgent);

    const firstSoulItem = firstTurn.combinedContextItems[0];
    expect(firstSoulItem.key).toBe("soulstream_session");
    expect(resume[0].key).toBe("soulstream_session");

    // content 키 집합 정합 (값 자체는 current_time 등 시점에 따라 달라지므로 key 비교).
    const firstKeys = Object.keys(firstSoulItem.content as Record<string, unknown>).sort();
    const resumeKeys = Object.keys(resume[0].content as Record<string, unknown>).sort();
    expect(firstKeys).toEqual(resumeKeys);
  });

  it("callerInfo 운반 → soulstream_item.content.caller_info (R-2 정합)", async () => {
    const cb = makeBuilder();
    const items = await cb.buildResumeContextItems(
      makeTask({
        callerInfo: { source: "agent", display_name: "서소영", agent_id: "seosoyoung" },
      }),
      codexAgent,
    );
    const content = items[0].content as Record<string, unknown>;
    expect(content.caller_info).toEqual({
      source: "agent",
      display_name: "서소영",
      agent_id: "seosoyoung",
    });
  });
});
