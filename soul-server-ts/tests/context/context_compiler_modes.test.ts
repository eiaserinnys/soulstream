import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONTEXT_COMPILER_VERSION,
  compileContexts,
} from "../../src/context/compiler/index.js";
import {
  fetchAtomContext,
  type AtomContextSpec,
  type AtomFetchConfig,
} from "../../src/context/atom_context.js";

const ROOT = "00000000-0000-4000-8000-000000000001";
const SECTION_A = "00000000-0000-4000-8000-000000000002";
const SECTION_B = "00000000-0000-4000-8000-000000000003";
const CARD_A1 = "00000000-0000-4000-8000-000000000004";
const CARD_A2 = "00000000-0000-4000-8000-000000000005";
const CARD_B1 = "00000000-0000-4000-8000-000000000006";
const CARD_A1_CHILD = "00000000-0000-4000-8000-000000000007";

const config: AtomFetchConfig = {
  enabled: true,
  serverUrl: "https://atom.test",
  apiKey: "key",
};

const logger = { warn: vi.fn() };

interface TreeNode {
  id: string;
  title: string;
  depth: number;
  chars: number;
  body: string;
}

const TREE: TreeNode[] = [
  { id: ROOT, title: "Root", depth: 0, chars: 9, body: "root body" },
  { id: SECTION_A, title: "Section A", depth: 1, chars: 6, body: "body A" },
  { id: CARD_A1, title: "Card A1", depth: 2, chars: 7, body: "body A1" },
  { id: CARD_A1_CHILD, title: "Card A1 child", depth: 3, chars: 13, body: "body A1 child" },
  { id: CARD_A2, title: "Card A2", depth: 2, chars: 7, body: "body A2" },
  { id: SECTION_B, title: "Section B", depth: 1, chars: 6, body: "body B" },
  { id: CARD_B1, title: "Card B1", depth: 2, chars: 7, body: "body B1" },
];

function metadata(node: TreeNode, includeChars: boolean): string {
  return `<!-- node:${node.id} card:${node.id} depth:${node.depth}${
    includeChars ? ` chars:${node.chars}` : ""
  } -->`;
}

function titlePrefix(depth: number): string {
  if (depth === 0) return "";
  return `${"  ".repeat(depth)}├── `;
}

function renderTree(url: URL): string {
  const depth = Number(url.searchParams.get("depth"));
  const titlesOnly = url.searchParams.get("titles_only") === "true";
  return TREE.filter((node) => node.depth <= depth)
    .map((node) => titlesOnly
      ? `${titlePrefix(node.depth)}${node.title} ${metadata(node, true)}`
      : `${"#".repeat(node.depth + 1)} ${node.title} ${metadata(node, false)}\n${node.body}`)
    .join("\n");
}

function outputNodeIds(markdown: string): Set<string> {
  return new Set(markdown.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g) ?? []);
}

function descendantOrSelf(nodeId: string, anchorId: string): boolean {
  const parents = new Map([
    [SECTION_A, ROOT],
    [SECTION_B, ROOT],
    [CARD_A1, SECTION_A],
    [CARD_A2, SECTION_A],
    [CARD_B1, SECTION_B],
    [CARD_A1_CHILD, CARD_A1],
  ]);
  let cursor: string | undefined = nodeId;
  while (cursor) {
    if (cursor === anchorId) return true;
    cursor = parents.get(cursor);
  }
  return false;
}

describe("context compiler Phase B render modes", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    logger.warn.mockClear();
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(input.toString());
      return new Response(JSON.stringify({ markdown: renderTree(url) }), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders full mode without metadata and anchors every depth cut", async () => {
    const compiled = await compileContexts(
      config,
      [{ nodeId: ROOT, depth: 1, titlesOnly: true, includeIds: true, mode: "full" }],
      logger,
    );

    expect(compiled.sections[0]?.markdown).toMatchInlineSnapshot(`
      "# Root
      root body
      ## Section A
      body A
      ## Section B
      body B

      ## 드릴다운 앵커

      - Section A — \`compile_subtree(node_id=\"00000000-0000-4000-8000-000000000002\")\`
      - Section B — \`compile_subtree(node_id=\"00000000-0000-4000-8000-000000000003\")\`"
    `);
    expect(compiled.manifest).toMatchObject({
      compiler_version: "phase-b.v1",
      sources: [{ mode: "full", truncated: true, anchor_count: 2 }],
    });
    expect(outputNodeIds(compiled.sections[0]!.markdown!)).toEqual(
      new Set([SECTION_A, SECTION_B]),
    );
    for (const omitted of [CARD_A1, CARD_A1_CHILD, CARD_A2, CARD_B1]) {
      expect([...outputNodeIds(compiled.sections[0]!.markdown!)]
        .some((anchor) => descendantOrSelf(omitted, anchor))).toBe(true);
    }
  });

  it("renders index mode as root body plus a direct-child drilldown table", async () => {
    const compiled = await compileContexts(
      config,
      [{ nodeId: ROOT, depth: 4, titlesOnly: false, mode: "index" }],
      logger,
    );

    expect(compiled.sections[0]?.markdown).toMatchInlineSnapshot(`
      "# Root
      root body

      ## 드릴다운 색인

      | 제목 | node_id | chars |
      | --- | --- | ---: |
      | Section A | \`00000000-0000-4000-8000-000000000002\` | 6 |
      | Section B | \`00000000-0000-4000-8000-000000000003\` | 6 |"
    `);
    expect(compiled.manifest.sources[0]).toMatchObject({
      mode: "index",
      truncated: true,
      anchor_count: 2,
    });
  });

  it("renders titles mode without per-title IDs and anchors the coarsest child subtrees", async () => {
    const compiled = await compileContexts(
      config,
      [{ nodeId: ROOT, depth: 2, titlesOnly: false, mode: "titles" }],
      logger,
    );

    expect(compiled.sections[0]?.markdown).toMatchInlineSnapshot(`
      "# Root
      root body

      ## 제목 트리

        ├── Section A
          ├── Card A1
          ├── Card A2
        ├── Section B
          ├── Card B1

      ## 드릴다운 앵커

      - Section A — \`compile_subtree(node_id=\"00000000-0000-4000-8000-000000000002\")\`
      - Section B — \`compile_subtree(node_id=\"00000000-0000-4000-8000-000000000003\")\`"
    `);
    const markdown = compiled.sections[0]!.markdown!;
    expect(outputNodeIds(markdown)).toEqual(new Set([SECTION_A, SECTION_B]));
    expect(compiled.manifest.sources[0]).toMatchObject({
      mode: "titles",
      truncated: true,
      anchor_count: 2,
    });
    for (const omitted of [SECTION_A, CARD_A1, CARD_A1_CHILD, CARD_A2, SECTION_B, CARD_B1]) {
      expect([...outputNodeIds(markdown)]
        .some((anchor) => descendantOrSelf(omitted, anchor))).toBe(true);
    }
  });

  it("uses the root as the single reachable anchor when limit omits a sibling subtree", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(input.toString());
      if (url.searchParams.get("titles_only") === "true" && url.searchParams.has("limit")) {
        const depth = Number(url.searchParams.get("depth"));
        const markdown = TREE.filter((node) => (
          node.depth <= depth && node.id !== SECTION_B && node.id !== CARD_B1
        )).map((node) => (
          `${titlePrefix(node.depth)}${node.title} ${metadata(node, true)}`
        )).join("\n");
        return new Response(JSON.stringify({ markdown }), { status: 200 });
      }
      return new Response(JSON.stringify({ markdown: renderTree(url) }), { status: 200 });
    }) as typeof fetch;

    const compiled = await compileContexts(
      config,
      [{ nodeId: ROOT, depth: 2, titlesOnly: false, limit: 1, mode: "titles" }],
      logger,
    );

    const markdown = compiled.sections[0]!.markdown!;
    expect(markdown).toContain("Section A");
    expect(markdown).not.toContain("Section B");
    expect(outputNodeIds(markdown)).toEqual(new Set([ROOT]));
    expect(compiled.manifest.sources[0]).toMatchObject({
      truncated: true,
      anchor_count: 1,
    });
    for (const omitted of [SECTION_A, CARD_A1, CARD_A1_CHILD, CARD_A2, SECTION_B, CARD_B1]) {
      expect(descendantOrSelf(omitted, ROOT)).toBe(true);
    }
  });

  it("uses the root anchor when the atom max_chars boundary hides an unknown suffix", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(input.toString());
      return new Response(JSON.stringify({
        markdown: `${renderTree(url)}\n<!-- truncated: 999 chars omitted -->`,
      }), { status: 200 });
    }) as typeof fetch;

    const compiled = await compileContexts(
      config,
      [{ nodeId: ROOT, depth: 1, titlesOnly: false, mode: "full" }],
      logger,
    );

    const markdown = compiled.sections[0]!.markdown!;
    expect(markdown).not.toContain("truncated: 999 chars omitted");
    expect(outputNodeIds(markdown)).toEqual(new Set([ROOT]));
    expect(compiled.manifest.sources[0]).toMatchObject({
      truncated: true,
      anchor_count: 1,
    });
  });

  it("does not reintroduce UUID source headers when assembling explicit full sources", async () => {
    const compiled = await compileContexts(
      config,
      [
        { nodeId: ROOT, depth: 3, titlesOnly: false, mode: "full" },
        { nodeId: SECTION_A, depth: 3, titlesOnly: false, mode: "full" },
      ],
      logger,
    );

    expect(outputNodeIds(compiled.assembled!)).toEqual(new Set());
    expect(compiled.assembled?.match(/# Root/g)).toHaveLength(2);
  });

  it("warns and preserves legacy bytes for an unknown mode", async () => {
    const spec = {
      nodeId: ROOT,
      depth: 1,
      titlesOnly: true,
      includeIds: false,
      mode: "future-mode",
    } satisfies AtomContextSpec;
    const legacy = await fetchAtomContext(
      config,
      spec.nodeId,
      spec.depth,
      spec.titlesOnly,
      logger,
      spec.limit,
      spec.includeIds,
    );
    const compiled = await compileContexts(config, [spec], logger);

    expect(compiled.assembled).toBe(legacy);
    expect(logger.warn).toHaveBeenCalledWith(
      { mode: "future-mode", nodeId: ROOT },
      "[context compiler] unknown atom render mode — using legacy rendering",
    );
    expect(compiled.manifest.sources[0]).toMatchObject({
      mode: "titles",
      truncated: false,
      anchor_count: 0,
    });
    expect(CONTEXT_COMPILER_VERSION).toBe("phase-b.v1");
  });

  it("keeps the existing null fallback when an explicit-mode atom query fails", async () => {
    globalThis.fetch = vi.fn(async () => new Response("unavailable", { status: 503 })) as typeof fetch;

    const compiled = await compileContexts(
      config,
      [{ nodeId: ROOT, depth: 2, titlesOnly: false, mode: "titles" }],
      logger,
    );

    expect(compiled.assembled).toBeNull();
    expect(compiled.manifest.sources[0]).toMatchObject({
      status: "error",
      chars: 0,
      truncated: false,
      anchor_count: 0,
    });
  });
});
