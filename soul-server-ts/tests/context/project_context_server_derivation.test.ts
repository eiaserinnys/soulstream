import pino from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AgentRegistry, type AgentProfile } from "../../src/agent_registry.js";
import {
  ExecutionContextBuilder,
  type ContextBuilderConfig,
} from "../../src/context/context_builder.js";
import { prioritizeAtomContextSpecs } from "../../src/context/context_builder_helpers.js";
import type { PageContextResolver } from "../../src/context/page_context_resolver.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { Task } from "../../src/task/task_models.js";

const logger = pino({ level: "silent" });
const atomConfig: ContextBuilderConfig["atom"] = {
  enabled: true,
  serverUrl: "https://atom.test",
  apiKey: "test-key",
};

const agent: AgentProfile = {
  id: "agent",
  name: "Agent",
  backend: "codex",
  workspace_dir: "/workspace",
};

function task(contextItems: Task["contextItems"] = []): Task {
  return {
    agentSessionId: "session-1",
    prompt: "work",
    status: "running",
    profileId: agent.id,
    createdAt: new Date("2026-08-03T00:00:00.000Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
    contextItems,
  };
}

function db(): SessionDB {
  return {
    getResumeContext: vi.fn().mockResolvedValue({
      session: { folder_id: "leaf" },
      folderSessions: { sessions: [], total: 0 },
      runningSessions: { sessions: [], total: 0 },
      predecessor: null,
    }),
    getSession: vi.fn().mockResolvedValue({ folder_id: "leaf" }),
    getFolderById: vi.fn().mockResolvedValue({
      id: "leaf",
      name: "Leaf",
      parent_folder_id: "root",
      project_page_id: "page-leaf",
      settings: {
        folderPrompt: "leaf prompt",
        atomContextNode: { nodeId: "folder-node", depth: 3 },
      },
    }),
    getCatalog: vi.fn().mockResolvedValue({
      folders: [
        {
          id: "root",
          name: "Root",
          parentFolderId: null,
          projectPageId: "page-root",
          settings: { folderPrompt: "root prompt" },
        },
        {
          id: "leaf",
          name: "Leaf",
          parentFolderId: "root",
          projectPageId: "page-leaf",
          settings: {
            folderPrompt: "leaf prompt",
            atomContextNode: { nodeId: "folder-node", depth: 3 },
          },
        },
      ],
      sessions: {},
    }),
  } as unknown as SessionDB;
}

function builder(
  database: SessionDB,
  resolver: PageContextResolver,
  selectedAgent: AgentProfile = agent,
): ExecutionContextBuilder {
  return new ExecutionContextBuilder(
    database,
    new AgentRegistry([selectedAgent]),
    { nodeId: "node-1", atom: atomConfig },
    logger,
    resolver,
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const nodeId = new URL(String(input)).pathname.split("/").at(-2);
    return new Response(JSON.stringify({ markdown: `# ${nodeId}` }), { status: 200 });
  }));
});

describe("project context server derivation contract", () => {
  it("applies session, page, folder, then agent atom priority by node id", () => {
    expect(prioritizeAtomContextSpecs({
      session: [{ nodeId: "session", depth: 1, titlesOnly: false }],
      pageNodeIds: ["session", "page"],
      folder: [
        { nodeId: "session", depth: 3, titlesOnly: true },
        { nodeId: "page", depth: 3, titlesOnly: true },
        { nodeId: "folder", depth: 3, titlesOnly: true },
      ],
      agent: [
        { nodeId: "page", depth: 5, titlesOnly: false },
        { nodeId: "folder", depth: 5, titlesOnly: false },
        { nodeId: "agent", depth: 5, titlesOnly: false },
      ],
    })).toEqual({
      session: [{ nodeId: "session", depth: 1, titlesOnly: false }],
      folder: [{ nodeId: "folder", depth: 3, titlesOnly: true }],
      agent: [{ nodeId: "agent", depth: 5, titlesOnly: false }],
    });
  });

  it("derives the root-to-leaf project pages for browser, app, and MCP-shaped inputs", async () => {
    const inputs = [
      {
        name: "browser",
        contextItems: [{
          key: "page_context_sources",
          content: { pages: [{ page_id: "page-root" }, { page_id: "page-leaf" }] },
        }],
      },
      { name: "app", contextItems: [] },
      { name: "mcp", contextItems: [] },
    ];

    const derivedContexts: unknown[] = [];
    for (const input of inputs) {
      const resolve = vi.fn(async (...args: unknown[]) => ({
        kind: "page-context" as const,
        atomNodeIds: [],
        contextItem: {
          key: "page_context",
          content: { source_page_ids: (args[3] as { pageIds?: string[] } | undefined)?.pageIds ?? [] },
        },
      }));
      const context = await builder(
        db(),
        { resolve } as PageContextResolver,
      ).build(task(input.contextItems), agent);

      expect(resolve).toHaveBeenCalledWith(
        expect.anything(),
        agent,
        atomConfig,
        expect.objectContaining({ pageIds: ["page-root", "page-leaf"] }),
      );
      expect(context.combinedContextItems.find((item) => item.key === "page_context")?.content)
        .toEqual({ source_page_ids: ["page-root", "page-leaf"] });
      derivedContexts.push({
        systemPrompt: context.effectiveSystemPrompt,
        projectContext: context.combinedContextItems
          .filter((item) => item.key === "page_context" || item.key === "atom_context"),
      });
    }
    expect(derivedContexts[0]).toEqual({
      systemPrompt: "root prompt\n\nleaf prompt",
      projectContext: [
        { key: "page_context", content: { source_page_ids: ["page-root", "page-leaf"] } },
        {
          key: "atom_context",
          label: "atom 트리",
          content: expect.stringContaining("# folder-node"),
        },
      ],
    });
    expect(derivedContexts[1]).toEqual(derivedContexts[0]);
    expect(derivedContexts[2]).toEqual(derivedContexts[0]);
  });

  it("keeps folderPrompt and folder atom context when a page anchor exists", async () => {
    const context = await builder(db(), {
      resolve: vi.fn().mockResolvedValue({
        kind: "page-context",
        atomNodeIds: [],
        contextItem: { key: "page_context", content: { items: [] } },
      }),
    }).build(task(), agent);

    expect(context.effectiveSystemPrompt).toBe("root prompt\n\nleaf prompt");
    expect(context.combinedContextItems.map((item) => item.key)).toContain("page_context");
    expect(context.combinedContextItems.map((item) => item.key)).toContain("atom_context");
  });

  it("deduplicates atom node ids by session, page, folder, then agent priority", async () => {
    const duplicateAgent: AgentProfile = {
      ...agent,
      atom_contexts: [{ node_id: "shared-node", depth: 5, titles_only: true }],
    };
    const database = db();
    vi.mocked(database.getFolderById).mockResolvedValue({
      id: "leaf",
      name: "Leaf",
      parent_folder_id: "root",
      project_page_id: "page-leaf",
      settings: {
        atomContextNode: { nodeId: "shared-node", depth: 4, titlesOnly: true },
      },
    } as never);
    vi.mocked(database.getCatalog).mockResolvedValue({
      folders: [{
        id: "leaf",
        name: "Leaf",
        parentFolderId: null,
        projectPageId: "page-leaf",
        settings: { atomContextNode: { nodeId: "shared-node", depth: 4, titlesOnly: true } },
      }],
      sessions: {},
    } as never);

    const resolve = vi.fn(async (...args: unknown[]) => {
      const excluded = new Set((args[3] as { excludedAtomNodeIds?: string[] } | undefined)?.excludedAtomNodeIds);
      return {
        kind: "page-context" as const,
        atomNodeIds: [],
        contextItem: {
          key: "page_context",
          content: {
            items: excluded.has("shared-node")
              ? []
              : [{ category: "atom_ref", node_id: "shared-node", depth: 2 }],
          },
        },
      };
    });
    const context = await builder(
      database,
      { resolve } as PageContextResolver,
      duplicateAgent,
    ).build(task([{
      key: "atom_context_sources",
      content: { nodes: [{ node_id: "shared-node", depth: 1, titles_only: false }] },
    }]), duplicateAgent);

    const atomFetches = vi.mocked(fetch).mock.calls
      .map(([input]) => new URL(String(input)))
      .filter((url) => url.pathname.includes("/api/tree/shared-node/compile"));
    expect(atomFetches).toHaveLength(1);
    expect(atomFetches[0]?.searchParams.get("depth")).toBe("1");
    expect(context.combinedContextItems.find((item) => item.key === "page_context")?.content)
      .toMatchObject({ items: [] });
    expect(context.combinedContextItems.map((item) => item.key)).not.toContain("atom_context");
    expect(context.effectiveSystemPrompt).toBeUndefined();
  });
});
