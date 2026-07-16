import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AtomFetchConfig } from "../../src/context/atom_context.js";
import { DefaultPageContextAssembler } from "../../src/context/page_context_assembler.js";
import type {
  MountParentResult,
  PageContextAnchor,
  PageContextPage,
  PageContextRepository,
} from "../../src/context/page_context_repository.js";
import { AncestorPageContextResolver } from "../../src/context/page_context_resolver.js";
import type { BlockDto } from "@soulstream/page-model";

const logger = pino({ level: "silent" });
const disabledAtomConfig: AtomFetchConfig = {
  enabled: false,
  serverUrl: "",
  apiKey: "",
};
const enabledAtomConfig: AtomFetchConfig = {
  enabled: true,
  serverUrl: "https://atom.test",
  apiKey: "key",
};

function block(
  id: string,
  parentId: string | null,
  blockType: string,
  text = id,
  properties: Record<string, unknown> = {},
  positionKey = id,
): BlockDto {
  return {
    id,
    page_id: "",
    parent_id: parentId,
    position_key: positionKey,
    block_type: blockType,
    text,
    properties,
    collapsed: false,
  };
}

function page(id: string, blocks: BlockDto[]): PageContextPage {
  return {
    page: {
      id,
      title: id,
      daily_date: null,
      version: 1,
      archived: false,
      metadata: {},
      created_at: "2026-07-13T00:00:00Z",
      updated_at: "2026-07-13T00:00:00Z",
    },
    blocks: blocks.map((entry) => ({ ...entry, page_id: id })),
  };
}

function repository(input: {
  anchor?: PageContextAnchor | null;
  pages?: Record<string, PageContextPage | Error>;
  parents?: Record<string, MountParentResult | Error>;
  anchorError?: Error;
} = {}): PageContextRepository & {
  getAnchor: ReturnType<typeof vi.fn>;
  getPage: ReturnType<typeof vi.fn>;
  listMountParents: ReturnType<typeof vi.fn>;
} {
  return {
    getAnchor: vi.fn(async () => {
      if (input.anchorError) throw input.anchorError;
      return input.anchor ?? { pageId: "target", blockId: "anchor" };
    }),
    getPage: vi.fn(async (pageId: string) => {
      const value = input.pages?.[pageId];
      if (value instanceof Error) throw value;
      if (!value) throw new Error(`missing page ${pageId}`);
      return value;
    }),
    listMountParents: vi.fn(async (pageId: string) => {
      const value = input.parents?.[pageId] ?? { items: [], truncated: false };
      if (value instanceof Error) throw value;
      return value;
    }),
  };
}

function resolve(
  repo: PageContextRepository,
  maxPages = 64,
  atomConfig: AtomFetchConfig = disabledAtomConfig,
) {
  return new AncestorPageContextResolver(
    repo,
    new DefaultPageContextAssembler(),
    logger,
    maxPages,
  ).resolve({ agentSessionId: "sess-1" } as never, {} as never, atomConfig);
}

function contentOf(result: Awaited<ReturnType<typeof resolve>>): Record<string, any> {
  expect(result.kind).toBe("page-anchor");
  return (result as any).contextItem.content;
}

describe("AncestorPageContextResolver", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("checks anchor presence without traversing page ancestry", async () => {
    const repo = repository({ anchor: { pageId: "target", blockId: "anchor" } });
    const resolver = new AncestorPageContextResolver(
      repo,
      new DefaultPageContextAssembler(),
      logger,
    );

    await expect(resolver.hasPageAnchor(
      { agentSessionId: "sess-1" } as never,
      {} as never,
    )).resolves.toBe(true);
    expect(repo.getAnchor).toHaveBeenCalledOnce();
    expect(repo.getPage).not.toHaveBeenCalled();
    expect(repo.listMountParents).not.toHaveBeenCalled();
  });

  it("renders physical three-depth explicit context root-to-leaf", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ markdown: "# compiled node" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const repo = repository({
      pages: {
        target: page("target", [
          block("root", null, "guidance", "root", { enabled: true, scope: "root" }, "a"),
          block("middle", "root", "atom_ref", "", { instance: "atom", nodeId: "node-1" }, "b"),
          block("leaf", "middle", "guidance", "leaf", { enabled: true, scope: "leaf" }, "c"),
          block("anchor", "leaf", "session_ref", "session", { sessionId: "sess-1", primary: true }, "d"),
        ]),
      },
    });

    const content = contentOf(await resolve(repo, 64, enabledAtomConfig));
    expect(content.items.map((entry: any) => entry.block_id)).toEqual([
      "root", "middle", "leaf",
    ]);
    expect(content.items[1]).toMatchObject({
      category: "atom_ref",
      instance: "atom",
      node_id: "node-1",
      depth: 3,
      titles_only: false,
      markdown: expect.stringContaining("# compiled node"),
    });
  });

  it("resolves explicit project pages root-to-leaf and lets the task page override shared scope", async () => {
    const repo = repository({
      pages: {
        target: page("target", [block("anchor", null, "session_ref")]),
        "project-root": page("project-root", [
          block("root-shared", null, "guidance", "root shared", { enabled: true, scope: "project" }, "a"),
          block("root-only", null, "guidance", "root only", { enabled: true, scope: "root" }, "b"),
        ]),
        "task-page": page("task-page", [
          block("task-shared", null, "guidance", "task shared", { enabled: true, scope: "project" }, "a"),
        ]),
      },
    });
    const task = {
      agentSessionId: "sess-1",
      contextItems: [{
        key: "page_context_sources",
        content: { pages: [{ page_id: "project-root" }, { page_id: "task-page" }] },
      }],
    } as never;
    const resolver = new AncestorPageContextResolver(
      repo,
      new DefaultPageContextAssembler(),
      logger,
    );

    const result = await resolver.resolve(task, {} as never, disabledAtomConfig);
    const content = contentOf(result);

    expect(content.items.map((entry: any) => [entry.block_id, entry.text])).toEqual([
      ["root-only", "root only"],
      ["task-shared", "task shared"],
    ]);
    expect(repo.getPage).toHaveBeenCalledWith("project-root");
    expect(repo.getPage).toHaveBeenCalledWith("task-page");
  });

  it("keeps the nearest explicit sources when the bounded traversal budget is exhausted", async () => {
    const repo = repository({
      pages: {
        target: page("target", [block("anchor", null, "session_ref")]),
        root: page("root", [block("root", null, "guidance", "root", { enabled: true, scope: "root" })]),
        child: page("child", [block("child", null, "guidance", "child", { enabled: true, scope: "child" })]),
        task: page("task", [block("task", null, "guidance", "task", { enabled: true, scope: "task" })]),
      },
    });
    const task = {
      agentSessionId: "sess-1",
      contextItems: [{
        key: "page_context_sources",
        content: { pages: [{ page_id: "root" }, { page_id: "child" }, { page_id: "task" }] },
      }],
    } as never;
    const resolver = new AncestorPageContextResolver(
      repo,
      new DefaultPageContextAssembler(),
      logger,
      3,
    );

    const content = contentOf(await resolver.resolve(task, {} as never, disabledAtomConfig));

    expect(content.items.map((entry: any) => entry.block_id)).toEqual(["child", "task"]);
    expect(repo.getPage).not.toHaveBeenCalledWith("root");
  });

  it("parses atom_ref depth and titlesOnly, clamps depth, and compiles selected refs", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async () =>
      new Response(JSON.stringify({ markdown: "compiled" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const repo = repository({
      pages: {
        target: page("target", [
          block("max", null, "atom_ref", "", {
            instance: "atom",
            nodeId: "node-max",
            depth: 99,
            titlesOnly: true,
          }),
          block("default", "max", "atom_ref", "", {
            instance: "atom",
            nodeId: "node-default",
            depth: "not-a-number",
            titlesOnly: "true",
          }),
          block("min", "default", "atom_ref", "", {
            instance: "atom",
            nodeId: "node-min",
            depth: -4,
          }),
          block("anchor", "min", "session_ref"),
        ]),
      },
    });

    const content = contentOf(await resolve(repo, 64, enabledAtomConfig));
    expect(content.items.map((entry: any) => ({
      nodeId: entry.node_id,
      depth: entry.depth,
      titlesOnly: entry.titles_only,
    }))).toEqual([
      { nodeId: "node-max", depth: 5, titlesOnly: true },
      { nodeId: "node-default", depth: 3, titlesOnly: false },
      { nodeId: "node-min", depth: 1, titlesOnly: false },
    ]);
    const urls = vi.mocked(globalThis.fetch).mock.calls.map(
      (call) => new URL(call[0].toString()),
    );
    expect(urls.map((url) => url.searchParams.get("depth"))).toEqual(["1", "3", "5"]);
    expect(urls.map((url) => url.searchParams.has("titles_only"))).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("compiles only the nearest duplicate atom_ref and preserves its depth", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ markdown: "nearest" }), { status: 200 }),
    );
    const repo = repository({
      pages: {
        target: page("target", [
          block("far", null, "atom_ref", "", {
            instance: "atom",
            nodeId: "same-node",
            depth: 5,
          }),
          block("near", "far", "atom_ref", "", {
            instance: "atom",
            nodeId: "same-node",
            depth: 2,
          }),
          block("anchor", "near", "session_ref"),
        ]),
      },
    });

    const content = contentOf(await resolve(repo, 64, enabledAtomConfig));
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("depth=2"),
      expect.any(Object),
    );
    expect(content.items).toEqual([
      expect.objectContaining({ block_id: "near", depth: 2, markdown: expect.stringContaining("nearest") }),
    ]);
    expect(content.metadata.deduplicated).toBe(1);
  });

  it("gracefully skips a failed atom compile while retaining other page context", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response("unavailable", { status: 503 }),
    );
    const repo = repository({
      pages: {
        target: page("target", [
          block("guidance", null, "guidance", "kept", {
            enabled: true,
            scope: "kept",
          }),
          block("atom", "guidance", "atom_ref", "", {
            instance: "atom",
            nodeId: "node-down",
          }),
          block("anchor", "atom", "session_ref"),
        ]),
      },
    });

    const content = contentOf(await resolve(repo, 64, enabledAtomConfig));
    expect(content.items).toEqual([
      expect.objectContaining({ block_id: "guidance", text: "kept" }),
    ]);
    expect(content.metadata.truncation.categories.atom_ref).toMatchObject({
      used: 0,
      omitted: 1,
    });
  });

  it("traverses two reverse mount parents in stable order", async () => {
    const repo = repository({
      pages: {
        target: page("target", [block("anchor", null, "session_ref")]),
        "parent-a": page("parent-a", [
          block("guidance-a", null, "guidance", "A", { enabled: true, scope: "a" }, "a"),
          block("mount-a", "guidance-a", "paragraph", "[[target]]", {}, "b"),
        ]),
        "parent-b": page("parent-b", [
          block("guidance-b", null, "guidance", "B", { enabled: true, scope: "b" }, "b"),
          block("mount-b", "guidance-b", "paragraph", "[[target]]", {}, "c"),
        ]),
      },
      parents: {
        target: {
          items: [
            { pageId: "parent-b", blockId: "mount-b" },
            { pageId: "parent-a", blockId: "mount-a" },
          ],
          truncated: false,
        },
      },
    });

    const content = contentOf(await resolve(repo));
    expect(content.items.map((entry: any) => entry.block_id)).toEqual([
      "guidance-a", "guidance-b",
    ]);
  });

  it("chooses the canonical fractional mount path when one page mounts the target twice", async () => {
    const repo = repository({
      pages: {
        target: page("target", [block("anchor", null, "session_ref")]),
        parent: page("parent", [
          block("guidance-by-id", null, "guidance", "wrong", {
            enabled: true,
            scope: "by-id",
          }, "A"),
          block("aaa-mount", "guidance-by-id", "paragraph", "[[target]]", {}, "a"),
          block("guidance-by-position", null, "guidance", "right", {
            enabled: true,
            scope: "by-position",
          }, "B"),
          block("zzz-mount", "guidance-by-position", "paragraph", "[[target]]", {}, "Z"),
        ]),
      },
      parents: {
        target: {
          items: [
            { pageId: "parent", blockId: "zzz-mount" },
            { pageId: "parent", blockId: "aaa-mount" },
          ],
          truncated: false,
        },
      },
    });

    const content = contentOf(await resolve(repo));
    expect(content.items).toEqual([
      expect.objectContaining({ block_id: "guidance-by-position", text: "right" }),
    ]);
    expect(repo.getPage).toHaveBeenCalledTimes(2);
  });

  it("deduplicates a diamond and terminates a mount cycle by page id", async () => {
    const repo = repository({
      pages: {
        target: page("target", [block("anchor", null, "session_ref")]),
        left: page("left", [block("mount-left", null, "paragraph")]),
        right: page("right", [block("mount-right", null, "paragraph")]),
        root: page("root", [
          block("root-guidance", null, "guidance", "root", { enabled: true, scope: "root" }),
          block("mount-root", "root-guidance", "paragraph"),
        ]),
      },
      parents: {
        target: { items: [
          { pageId: "left", blockId: "mount-left" },
          { pageId: "right", blockId: "mount-right" },
        ], truncated: false },
        left: { items: [{ pageId: "root", blockId: "mount-root" }], truncated: false },
        right: { items: [{ pageId: "root", blockId: "mount-root" }], truncated: false },
        root: { items: [{ pageId: "target", blockId: "anchor" }], truncated: false },
      },
    });

    const content = contentOf(await resolve(repo));
    expect(content.items.map((entry: any) => entry.block_id)).toEqual(["root-guidance"]);
    expect(repo.getPage).toHaveBeenCalledTimes(4);
    expect(content.metadata.traversal.visited_pages).toBe(4);
  });

  it("lets the nearer ancestor win the same semantic key", async () => {
    const repo = repository({
      pages: {
        target: page("target", [
          block("far", null, "guidance", "far", { enabled: true, scope: "shared" }),
          block("near", "far", "guidance", "near", { enabled: true, scope: "shared" }),
          block("anchor", "near", "session_ref"),
        ]),
      },
    });
    const content = contentOf(await resolve(repo));
    expect(content.items).toHaveLength(1);
    expect(content.items[0]).toMatchObject({ block_id: "near", text: "near" });
  });

  it("resolves session defaults near-first without rendering them into the prompt", async () => {
    const repo = repository({
      pages: {
        target: page("target", [
          block("defaults-far", null, "session_defaults", "", {
            scope: "run",
            agentId: "agent-far",
          }),
          block("defaults-near", "defaults-far", "session_defaults", "", {
            scope: "run",
            agentId: "agent-near",
            nodeId: "node-near",
          }),
          block("guidance", "defaults-near", "guidance", "visible", {
            enabled: true,
            scope: "visible",
          }),
          block("anchor", "guidance", "session_ref"),
        ]),
      },
    });

    const content = contentOf(await resolve(repo));
    expect(content.items.map((entry: any) => entry.block_id)).toEqual(["guidance"]);
    expect(content.metadata.deduplicated).toBe(1);
    expect(content.metadata.truncation.categories.session_defaults).toEqual({
      limit: 0,
      used: 0,
      omitted: 1,
    });
  });

  it("excludes prose, session_ref, checklist, and disabled guidance", async () => {
    const repo = repository({
      pages: {
        target: page("target", [
          block("guidance", null, "guidance", "kept", { enabled: true, scope: "kept" }),
          block("prose", "guidance", "paragraph", "not context"),
          block("check", "prose", "checklist", "not context", { checked: false }),
          block("disabled", "check", "guidance", "not context", { enabled: false, scope: "off" }),
          block("session", "disabled", "session_ref", "not context"),
          block("anchor", "session", "session_ref"),
        ]),
      },
    });
    const content = contentOf(await resolve(repo));
    expect(content.items.map((entry: any) => entry.block_id)).toEqual(["guidance"]);
  });

  it("falls back to legacy context when binding lookup fails", async () => {
    const repo = repository({ anchorError: new Error("db unavailable") });
    await expect(resolve(repo)).resolves.toEqual({ kind: "no-page-anchor" });
  });

  it("isolates one missing parent branch while keeping anchored context", async () => {
    const repo = repository({
      pages: {
        target: page("target", [
          block("target-guidance", null, "guidance", "target", { enabled: true, scope: "target" }),
          block("anchor", "target-guidance", "session_ref"),
        ]),
        good: page("good", [
          block("good-guidance", null, "guidance", "good", { enabled: true, scope: "good" }),
          block("good-mount", "good-guidance", "paragraph"),
        ]),
        missing: new Error("page host 404 forbidden"),
      },
      parents: {
        target: { items: [
          { pageId: "good", blockId: "good-mount" },
          { pageId: "missing", blockId: "missing-mount" },
        ], truncated: false },
      },
    });
    const content = contentOf(await resolve(repo));
    expect(content.items.map((entry: any) => entry.block_id)).toEqual([
      "good-guidance", "target-guidance",
    ]);
    expect(content.metadata.traversal.failures).toEqual([
      expect.objectContaining({ stage: "page", page_id: "missing" }),
    ]);
  });

  it("records a missing entry block and still traverses that page's reverse mount parents", async () => {
    const repo = repository({
      pages: {
        target: page("target", [block("anchor", null, "session_ref")]),
        parent: page("parent", [block("unrelated", null, "paragraph")]),
        root: page("root", [
          block("root-guidance", null, "guidance", "root", {
            enabled: true,
            scope: "root",
          }, "A"),
          block("root-mount", "root-guidance", "paragraph", "[[parent]]", {}, "B"),
        ]),
      },
      parents: {
        target: {
          items: [{ pageId: "parent", blockId: "deleted-mount" }],
          truncated: false,
        },
        parent: {
          items: [{ pageId: "root", blockId: "root-mount" }],
          truncated: false,
        },
      },
    });

    const content = contentOf(await resolve(repo));
    expect(content.items).toEqual([
      expect.objectContaining({ block_id: "root-guidance", text: "root" }),
    ]);
    expect(content.metadata.traversal.failures).toEqual([
      expect.objectContaining({
        stage: "block",
        page_id: "parent",
        block_id: "deleted-mount",
      }),
    ]);
  });

  it("keeps target context when reverse mount lookup fails", async () => {
    const repo = repository({
      pages: {
        target: page("target", [
          block("guidance", null, "guidance", "kept", { enabled: true, scope: "kept" }),
          block("anchor", "guidance", "session_ref"),
        ]),
      },
      parents: { target: new Error("backlink host unavailable") },
    });
    const content = contentOf(await resolve(repo));
    expect(content.items).toEqual([
      expect.objectContaining({ block_id: "guidance", text: "kept" }),
    ]);
    expect(content.metadata.traversal.failures).toEqual([
      expect.objectContaining({ stage: "mounts", page_id: "target" }),
    ]);
  });

  it("preserves the durable anchor and isolates a target page read failure", async () => {
    const content = contentOf(await resolve(repository({
      pages: { target: new Error("owner page host unavailable") },
    })));
    expect(content.anchor).toEqual({ page_id: "target", block_id: "anchor" });
    expect(content.items).toEqual([]);
    expect(content.metadata.traversal.failures).toEqual([
      expect.objectContaining({ stage: "page", page_id: "target" }),
    ]);
  });

  it("caps traversal pages and marks metadata without throwing", async () => {
    const repo = repository({
      pages: {
        target: page("target", [block("anchor", null, "session_ref")]),
        parent: page("parent", [block("mount", null, "paragraph")]),
      },
      parents: {
        target: { items: [{ pageId: "parent", blockId: "mount" }], truncated: false },
      },
    });
    const content = contentOf(await resolve(repo, 1));
    expect(content.metadata.traversal).toMatchObject({
      visited_pages: 1,
      truncated: true,
    });
  });
});
