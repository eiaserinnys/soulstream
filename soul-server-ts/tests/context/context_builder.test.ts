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

  it("folderPrompt는 root부터 leaf까지 상속 합성하고 빈 prompt는 건너뛴다", async () => {
    const getSession = vi.fn().mockResolvedValue({ folder_id: "leaf" });
    const getFolderById = vi.fn().mockResolvedValue({
      id: "leaf",
      name: "Leaf",
      sort_order: 2,
      parent_folder_id: "middle",
      settings: { folderPrompt: "leaf prompt" },
    });
    const getCatalog = vi.fn().mockResolvedValue({
      folders: [
        {
          id: "root",
          name: "Root",
          sortOrder: 0,
          parentFolderId: null,
          settings: { folderPrompt: "root prompt" },
        },
        {
          id: "middle",
          name: "Middle",
          sortOrder: 1,
          parentFolderId: "root",
          settings: { folderPrompt: "" },
        },
        {
          id: "leaf",
          name: "Leaf",
          sortOrder: 2,
          parentFolderId: "middle",
          settings: { folderPrompt: "leaf prompt" },
        },
      ],
      sessions: {},
    });
    const cb = makeBuilder({ getSession, getFolderById, getCatalog } as Partial<SessionDB>);

    const ctx = await cb.build(
      makeTask({ systemPrompt: "task system" }),
      codexAgent,
    );

    expect(ctx.effectiveSystemPrompt).toBe("root prompt\n\nleaf prompt\n\ntask system");
  });

  it("folderPrompt 상속은 동일 텍스트 중복을 한 번만 유지한다", async () => {
    const getSession = vi.fn().mockResolvedValue({ folder_id: "leaf" });
    const getFolderById = vi.fn().mockResolvedValue({
      id: "leaf",
      name: "Leaf",
      sort_order: 2,
      parent_folder_id: "middle",
      settings: { folderPrompt: "shared prompt" },
    });
    const getCatalog = vi.fn().mockResolvedValue({
      folders: [
        {
          id: "root",
          name: "Root",
          sortOrder: 0,
          parentFolderId: null,
          settings: { folderPrompt: "shared prompt" },
        },
        {
          id: "middle",
          name: "Middle",
          sortOrder: 1,
          parentFolderId: "root",
          settings: { folderPrompt: "middle prompt" },
        },
        {
          id: "leaf",
          name: "Leaf",
          sortOrder: 2,
          parentFolderId: "middle",
          settings: { folderPrompt: "shared prompt" },
        },
      ],
      sessions: {},
    });
    const cb = makeBuilder({ getSession, getFolderById, getCatalog } as Partial<SessionDB>);

    const ctx = await cb.build(
      makeTask({ systemPrompt: "task system" }),
      codexAgent,
    );

    expect(ctx.effectiveSystemPrompt).toBe("shared prompt\n\nmiddle prompt\n\ntask system");
  });

  it("folder chain cycle이 있어도 방문한 경로만 합성하고 종료한다", async () => {
    const getSession = vi.fn().mockResolvedValue({ folder_id: "leaf" });
    const getFolderById = vi.fn().mockResolvedValue({
      id: "leaf",
      name: "Leaf",
      sort_order: 1,
      parent_folder_id: "parent",
      settings: { folderPrompt: "leaf prompt" },
    });
    const getCatalog = vi.fn().mockResolvedValue({
      folders: [
        {
          id: "parent",
          name: "Parent",
          sortOrder: 0,
          parentFolderId: "leaf",
          settings: { folderPrompt: "parent prompt" },
        },
        {
          id: "leaf",
          name: "Leaf",
          sortOrder: 1,
          parentFolderId: "parent",
          settings: { folderPrompt: "leaf prompt" },
        },
      ],
      sessions: {},
    });
    const cb = makeBuilder({ getSession, getFolderById, getCatalog } as Partial<SessionDB>);

    const ctx = await cb.build(makeTask(), codexAgent);

    expect(ctx.effectiveSystemPrompt).toBe("parent prompt\n\nleaf prompt");
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

  it("folder atomContextNode는 root부터 leaf까지 상속 fetch한다", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ markdown: "# root atom\nbody" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ markdown: "# leaf atom\nbody" }), { status: 200 }),
      );
    const getSession = vi.fn().mockResolvedValue({ folder_id: "leaf" });
    const getFolderById = vi.fn().mockResolvedValue({
      id: "leaf",
      name: "Leaf",
      sort_order: 2,
      parent_folder_id: "root",
      settings: {
        atomContextNode: {
          nodeId: "22222222-3333-4444-5555-666666666666",
          depth: 4,
          titlesOnly: false,
        },
      },
    });
    const getCatalog = vi.fn().mockResolvedValue({
      folders: [
        {
          id: "root",
          name: "Root",
          sortOrder: 0,
          parentFolderId: null,
          settings: {
            atomContextNode: {
              nodeId: "11111111-2222-3333-4444-555555555555",
              depth: 2,
              titlesOnly: true,
            },
          },
        },
        {
          id: "leaf",
          name: "Leaf",
          sortOrder: 2,
          parentFolderId: "root",
          settings: {
            atomContextNode: {
              nodeId: "22222222-3333-4444-5555-666666666666",
              depth: 4,
              titlesOnly: false,
            },
          },
        },
      ],
      sessions: {},
    });
    const cb = makeBuilder({ getSession, getFolderById, getCatalog } as Partial<SessionDB>, undefined, true);

    const ctx = await cb.build(makeTask(), codexAgent);

    const urls = vi.mocked(globalThis.fetch).mock.calls.map(([url]) => new URL(String(url)));
    expect(urls).toHaveLength(2);
    expect(urls[0].pathname).toContain("/api/tree/11111111-2222-3333-4444-555555555555/compile");
    expect(urls[0].searchParams.get("depth")).toBe("2");
    expect(urls[0].searchParams.get("titles_only")).toBe("true");
    expect(urls[1].pathname).toContain("/api/tree/22222222-3333-4444-5555-666666666666/compile");
    expect(urls[1].searchParams.get("depth")).toBe("4");
    expect(urls[1].searchParams.has("titles_only")).toBe(false);
    const atomItem = ctx.combinedContextItems.find((item) => item.key === "atom_context");
    expect(atomItem).toBeDefined();
    const content = String(atomItem?.content);
    expect(content.indexOf("# root atom")).toBeLessThan(content.indexOf("# leaf atom"));
  });

  it("folder atomContextNode 중복 nodeId는 leaf 설정으로 한 번만 fetch한다", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ markdown: "# leaf atom\nbody" }), { status: 200 }),
    );
    const getSession = vi.fn().mockResolvedValue({ folder_id: "leaf" });
    const getFolderById = vi.fn().mockResolvedValue({
      id: "leaf",
      name: "Leaf",
      sort_order: 1,
      parent_folder_id: "root",
      settings: {
        atomContextNode: {
          nodeId: "11111111-2222-3333-4444-555555555555",
          depth: 5,
          titlesOnly: false,
        },
      },
    });
    const getCatalog = vi.fn().mockResolvedValue({
      folders: [
        {
          id: "root",
          name: "Root",
          sortOrder: 0,
          parentFolderId: null,
          settings: {
            atomContextNode: {
              nodeId: "11111111-2222-3333-4444-555555555555",
              depth: 2,
              titlesOnly: true,
            },
          },
        },
        {
          id: "leaf",
          name: "Leaf",
          sortOrder: 1,
          parentFolderId: "root",
          settings: {
            atomContextNode: {
              nodeId: "11111111-2222-3333-4444-555555555555",
              depth: 5,
              titlesOnly: false,
            },
          },
        },
      ],
      sessions: {},
    });
    const cb = makeBuilder({ getSession, getFolderById, getCatalog } as Partial<SessionDB>, undefined, true);

    const ctx = await cb.build(makeTask(), codexAgent);

    const urls = vi.mocked(globalThis.fetch).mock.calls.map(([url]) => new URL(String(url)));
    expect(urls).toHaveLength(1);
    expect(urls[0].searchParams.get("depth")).toBe("5");
    expect(urls[0].searchParams.has("titles_only")).toBe(false);
    const atomItem = ctx.combinedContextItems.find((item) => item.key === "atom_context");
    expect(atomItem?.content).toContain("# leaf atom");
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

  it("현재 폴더의 직접 자식만 board_workspace context item에 최소 필드로 주입", async () => {
    const getSession = vi.fn().mockResolvedValue({ folder_id: "root" });
    const getFolderById = vi.fn().mockResolvedValue({
      id: "root",
      name: "Root",
      sort_order: 0,
      settings: {},
    });
    const listSessionsSummary = vi.fn().mockResolvedValue({
      sessions: [
        {
          session_id: "sess-direct",
          display_name: "Direct Session",
          updated_at: new Date("2026-06-07T04:00:00.000Z"),
        },
      ],
      total: 1,
    });
    const getCatalog = vi.fn().mockResolvedValue({
      folders: [
        { id: "root", name: "Root", sortOrder: 0, settings: {}, parentFolderId: null },
        { id: "child", name: "Child", sortOrder: 1, settings: {}, parentFolderId: "root" },
        { id: "grandchild", name: "Grandchild", sortOrder: 2, settings: {}, parentFolderId: "child" },
      ],
      sessions: {
        "sess-direct": { folderId: "root", displayName: "Direct Session" },
        "sess-nested": { folderId: "child", displayName: "Nested Session" },
      },
    });
    const cb = makeBuilder({
      getSession,
      getFolderById,
      getCatalog,
      listSessionsSummary,
    } as Partial<SessionDB>);

    const ctx = await cb.build(makeTask(), codexAgent);
    const boardItem = ctx.combinedContextItems.find((item) => item.key === "board_workspace");

    expect(boardItem).toBeDefined();
    expect(boardItem?.content).toEqual({
      folder_id: "root",
      folders: [
        {
          id: "child",
          name: "Child",
          direct_child_count: 2,
        },
      ],
      sessions: [
        {
          agent_session_id: "sess-direct",
          title: "Direct Session",
        },
      ],
    });
    expect(listSessionsSummary).toHaveBeenCalledWith({
      limit: 15,
      offset: 0,
      folderId: "root",
    });
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

describe("ExecutionContextBuilder.build — board_workspace/running_sessions context", () => {
  it("board_workspace.sessions는 updated_at DESC page의 최근 15개만 주입하고 잘림 메타를 붙인다", async () => {
    const getSession = vi.fn().mockResolvedValue({ folder_id: "root" });
    const getFolderById = vi.fn().mockResolvedValue({
      id: "root",
      name: "Root",
      sort_order: 0,
      settings: {},
    });
    const getCatalog = vi.fn().mockResolvedValue({
      folders: [
        { id: "root", name: "Root", sortOrder: 0, settings: {}, parentFolderId: null },
      ],
      sessions: Object.fromEntries(
        Array.from({ length: 16 }, (_, idx) => [
          `sess-${idx}`,
          { folderId: "root", displayName: `Catalog ${idx}` },
        ]),
      ),
    });
    const rows = Array.from({ length: 15 }, (_, idx) => ({
      session_id: `sess-${idx}`,
      display_name: `Recent ${idx}`,
      status: idx === 0 ? "running" : "completed",
      session_type: "claude",
      created_at: new Date(`2026-06-${String(idx + 1).padStart(2, "0")}T00:00:00Z`),
      updated_at: new Date(`2026-06-${String(20 - idx).padStart(2, "0")}T00:00:00Z`),
      event_count: idx,
      away_summary: null,
      caller_session_id: null,
    }));
    const listSessionsSummary = vi.fn().mockResolvedValue({ sessions: rows, total: 16 });
    const cb = makeBuilder({
      getSession,
      getFolderById,
      getCatalog,
      listSessionsSummary,
    } as unknown as Partial<SessionDB>);

    const ctx = await cb.build(makeTask(), codexAgent);
    const boardItem = ctx.combinedContextItems.find((item) => item.key === "board_workspace");
    const content = boardItem?.content as Record<string, unknown>;

    expect(listSessionsSummary).toHaveBeenCalledWith({
      folderId: "root",
      limit: 15,
      offset: 0,
    });
    expect(content.sessions).toEqual(
      rows.map((row) => ({
        agent_session_id: row.session_id,
        title: row.display_name,
      })),
    );
    expect(content.sessions_truncated).toEqual({
      total: 16,
      shown: 15,
      sort: "updated_at_desc",
      message: "Showing 15 most recently active sessions out of 16.",
    });
  });

  it("board_workspace.sessions가 정확히 15개이거나 0개이면 잘림 메타를 붙이지 않는다", async () => {
    async function buildWithPage(total: number) {
      const getSession = vi.fn().mockResolvedValue({ folder_id: "root" });
      const getFolderById = vi.fn().mockResolvedValue({
        id: "root",
        name: "Root",
        sort_order: 0,
        settings: {},
      });
      const getCatalog = vi.fn().mockResolvedValue({
        folders: [
          { id: "root", name: "Root", sortOrder: 0, settings: {}, parentFolderId: null },
        ],
        sessions: {},
      });
      const sessions = Array.from({ length: total }, (_, idx) => ({
        session_id: `sess-${idx}`,
        display_name: `Session ${idx}`,
        status: "completed",
        session_type: "claude",
        created_at: new Date("2026-06-01T00:00:00Z"),
        updated_at: new Date("2026-06-01T00:00:00Z"),
        event_count: 0,
        away_summary: null,
        caller_session_id: null,
      }));
      const listSessionsSummary = vi.fn().mockResolvedValue({ sessions, total });
      const cb = makeBuilder({
        getSession,
        getFolderById,
        getCatalog,
        listSessionsSummary,
      } as unknown as Partial<SessionDB>);
      const ctx = await cb.build(makeTask(), codexAgent);
      const boardItem = ctx.combinedContextItems.find((item) => item.key === "board_workspace");
      return boardItem?.content as Record<string, unknown>;
    }

    expect(await buildWithPage(15)).not.toHaveProperty("sessions_truncated");
    expect(await buildWithPage(0)).not.toHaveProperty("sessions_truncated");
  });

  it("running_sessions는 현재 세션을 제외하고 최근 15개와 잘림 메타를 주입한다", async () => {
    const rows = Array.from({ length: 15 }, (_, idx) => ({
      session_id: `running-${idx}`,
      display_name: idx === 0 ? null : `Running ${idx}`,
      node_id: idx % 2 === 0 ? "node-A" : "node-B",
      folder_id: idx % 2 === 0 ? "folder-A" : null,
      updated_at: new Date(`2026-06-${String(20 - idx).padStart(2, "0")}T00:00:00Z`),
    }));
    const listRunningSessionsSummary = vi.fn().mockResolvedValue({
      sessions: rows,
      total: 16,
    });
    const cb = makeBuilder({
      listRunningSessionsSummary,
    } as unknown as Partial<SessionDB>);

    const ctx = await cb.build(makeTask({ agentSessionId: "sess-current" }), codexAgent);
    const runningItem = ctx.combinedContextItems.find((item) => item.key === "running_sessions");
    const content = runningItem?.content as Record<string, unknown>;

    expect(listRunningSessionsSummary).toHaveBeenCalledWith({
      limit: 15,
      offset: 0,
      excludeSessionId: "sess-current",
    });
    expect(content).toMatchObject({
      status: "ok",
      scope: "current_node",
      current_session_id: "sess-current",
      running_sessions_truncated: {
        total: 16,
        shown: 15,
        sort: "updated_at_desc",
        message: "Showing 15 most recently active running sessions out of 16.",
      },
    });
    expect(content.sessions).toEqual([
      {
        agent_session_id: "running-0",
        title: "running-0",
        node_id: "node-A",
        folder_id: "folder-A",
        updated_at: "2026-06-20T00:00:00.000Z",
      },
      ...rows.slice(1).map((row) => ({
        agent_session_id: row.session_id,
        title: row.display_name,
        node_id: row.node_id,
        folder_id: row.folder_id,
        updated_at: row.updated_at.toISOString(),
      })),
    ]);
  });

  it("running_sessions 조회 실패는 warning context item으로 격리하고 build는 계속한다", async () => {
    const listRunningSessionsSummary = vi.fn().mockRejectedValue(new Error("db down"));
    const cb = makeBuilder({
      listRunningSessionsSummary,
    } as unknown as Partial<SessionDB>);

    const ctx = await cb.build(makeTask({ agentSessionId: "sess-current" }), codexAgent);
    const runningItem = ctx.combinedContextItems.find((item) => item.key === "running_sessions");

    expect(ctx.combinedContextItems[0].key).toBe("soulstream_session");
    expect(runningItem?.content).toEqual({
      status: "unavailable",
      scope: "current_node",
      current_session_id: "sess-current",
      sessions: [],
      warnings: [
        {
          code: "running_sessions_unavailable",
          message: "Running sessions unavailable; startup continues without live running session context.",
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

describe("ExecutionContextBuilder.buildSystemPrompt — Claude resume system prompt", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn() as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("agent atom_contexts + folderPrompt + task.systemPrompt만 조립하고 context item용 atomContextNode는 제외", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ markdown: "# agent rules\nbody" }), { status: 200 }),
    );
    const getSession = vi.fn().mockResolvedValue({ folder_id: "f-1" });
    const getFolderById = vi.fn().mockResolvedValue({
      id: "f-1",
      name: "folder",
      sort_order: 0,
      settings: {
        folderPrompt: "folder prompt",
        atomContextNode: {
          nodeId: "11111111-2222-3333-4444-555555555555",
          depth: 2,
        },
      },
    });
    const agent: AgentProfile = {
      ...codexAgent,
      atom_contexts: [
        {
          node_id: "22222222-3333-4444-5555-666666666666",
          depth: 3,
          titles_only: false,
        },
      ],
    };
    const cb = makeBuilder(
      { getSession, getFolderById } as Partial<SessionDB>,
      new AgentRegistry([agent]),
      true,
    );

    const prompt = await cb.buildSystemPrompt(
      makeTask({ systemPrompt: "task prompt" }),
      agent,
    );

    expect(prompt).toContain("# agent rules");
    expect(prompt).toContain("\n\nfolder prompt\n\ntask prompt");
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it("resume system prompt도 folderPrompt 상속 chain을 사용한다", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ markdown: "# agent rules\nbody" }), { status: 200 }),
    );
    const getSession = vi.fn().mockResolvedValue({ folder_id: "leaf" });
    const getFolderById = vi.fn().mockResolvedValue({
      id: "leaf",
      name: "Leaf",
      sort_order: 2,
      parent_folder_id: "root",
      settings: { folderPrompt: "leaf prompt" },
    });
    const getCatalog = vi.fn().mockResolvedValue({
      folders: [
        {
          id: "root",
          name: "Root",
          sortOrder: 0,
          parentFolderId: null,
          settings: { folderPrompt: "root prompt" },
        },
        {
          id: "leaf",
          name: "Leaf",
          sortOrder: 2,
          parentFolderId: "root",
          settings: { folderPrompt: "leaf prompt" },
        },
      ],
      sessions: {},
    });
    const agent: AgentProfile = {
      ...codexAgent,
      atom_contexts: [
        {
          node_id: "22222222-3333-4444-5555-666666666666",
          depth: 3,
          titles_only: false,
        },
      ],
    };
    const cb = makeBuilder(
      { getSession, getFolderById, getCatalog } as Partial<SessionDB>,
      new AgentRegistry([agent]),
      true,
    );

    const prompt = await cb.buildSystemPrompt(
      makeTask({ systemPrompt: "task prompt" }),
      agent,
    );

    expect(prompt).toContain("\n\nroot prompt\n\nleaf prompt\n\ntask prompt");
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });
});
