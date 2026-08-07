import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONTEXT_COMPILER_VERSION,
  compileContexts,
  mergeContextManifests,
} from "../../src/context/compiler/index.js";
import {
  fetchAtomContext,
  fetchAtomContexts,
  type AtomContextSpec,
  type AtomFetchConfig,
} from "../../src/context/atom_context.js";

const silentLogger = pino({ level: "silent" });
const config: AtomFetchConfig = {
  enabled: true,
  serverUrl: "https://atom.test",
  apiKey: "key",
};

describe("context compiler golden parity", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(input.toString());
      return new Response(JSON.stringify({ markdown: `compiled:${url.search}` }), {
        status: 200,
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const cases: Array<{ name: string; spec: AtomContextSpec; expectedQuery: string }> = [
    {
      name: "depth full",
      spec: { nodeId: "node-full", depth: 5, titlesOnly: false },
      expectedQuery: "depth=5",
    },
    {
      name: "titles_only",
      spec: { nodeId: "node-titles", depth: 2, titlesOnly: true },
      expectedQuery: "titles_only=true",
    },
    {
      name: "include_ids false",
      spec: { nodeId: "node-no-ids", depth: 3, titlesOnly: false, includeIds: false },
      expectedQuery: "include_ids=false",
    },
    {
      name: "limit",
      spec: { nodeId: "node-limited", depth: 1, titlesOnly: false, limit: 7 },
      expectedQuery: "limit=7",
    },
  ];

  for (const golden of cases) {
    it(`preserves legacy output for ${golden.name}`, async () => {
      const legacy = await fetchAtomContext(
        config,
        golden.spec.nodeId,
        golden.spec.depth,
        golden.spec.titlesOnly,
        silentLogger,
        golden.spec.limit,
        golden.spec.includeIds,
      );

      const compiled = await compileContexts(config, [golden.spec], silentLogger);

      expect(compiled.assembled).toBe(legacy);
      expect(compiled.sections).toHaveLength(1);
      expect(compiled.sections[0]?.source).toMatchObject({
        id: golden.spec.nodeId,
        instance: "atom",
        ...golden.spec,
        priority: 0,
        neverTruncate: false,
      });
      expect(compiled.manifest).toMatchObject({
        compiler_version: CONTEXT_COMPILER_VERSION,
        source_count: 1,
        sources: [expect.objectContaining({
          node_id: golden.spec.nodeId,
          depth: golden.spec.depth,
          titles_only: golden.spec.titlesOnly,
          status: "ok",
        })],
      });
      expect(compiled.manifest.spec_hash).toMatch(/^[0-9a-f]{64}$/);
      const compilerUrl = vi.mocked(globalThis.fetch).mock.calls[1]?.[0]?.toString() ?? "";
      expect(compilerUrl).toContain(golden.expectedQuery);
    });
  }

  it("preserves multi-source assembly and partial-failure fallback", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url = new URL(input.toString());
      if (url.pathname.includes("node-error")) {
        return new Response("unavailable", { status: 503 });
      }
      return new Response(JSON.stringify({ markdown: "# surviving source" }), { status: 200 });
    });
    const specs: AtomContextSpec[] = [
      { nodeId: "node-error", depth: 1, titlesOnly: false },
      { nodeId: "node-ok", depth: 2, titlesOnly: true, includeIds: false },
    ];

    const legacy = await fetchAtomContexts(config, specs, silentLogger);
    const compiled = await compileContexts(config, specs, silentLogger);

    expect(compiled.assembled).toBe(legacy);
    expect(compiled.sections).toHaveLength(2);
    expect(compiled.sections[0]?.markdown).toBeNull();
    expect(compiled.sections[1]?.markdown).toBe("# surviving source");
  });

  it("records ok, empty, and error observations without changing fallback output", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url = new URL(input.toString());
      if (url.pathname.includes("node-error")) {
        return new Response("unavailable", { status: 503 });
      }
      if (url.pathname.includes("node-empty")) {
        return new Response(JSON.stringify({ markdown: "" }), { status: 200 });
      }
      return new Response(JSON.stringify({ markdown: "# 안녕" }), { status: 200 });
    });
    const specs: AtomContextSpec[] = [
      { nodeId: "node-ok", depth: 5, titlesOnly: false, includeIds: false, limit: 9 },
      { nodeId: "node-empty", depth: 2, titlesOnly: true },
      { nodeId: "node-error", depth: 1, titlesOnly: false },
    ];

    const compiled = await compileContexts(config, specs, silentLogger);

    expect(compiled.manifest).toMatchObject({
      compiler_version: CONTEXT_COMPILER_VERSION,
      source_count: 3,
      total_chars: compiled.assembled?.length,
      total_token_estimate: Math.ceil((compiled.assembled?.length ?? 0) / 4),
      sources: [
        {
          id: "node-ok",
          label: "atom node: node-ok",
          instance: "atom",
          node_id: "node-ok",
          mode: "full",
          depth: 5,
          titles_only: false,
          include_ids: false,
          limit: 9,
          priority: 0,
          never_truncate: false,
          chars: 4,
          token_estimate: 1,
          status: "ok",
          truncated: false,
          anchor_count: 0,
        },
        expect.objectContaining({ node_id: "node-empty", mode: "titles", status: "empty", chars: 0 }),
        expect.objectContaining({ node_id: "node-error", status: "error", chars: 0 }),
      ],
    });
  });

  it("hashes the desired spec deterministically and changes when the spec changes", async () => {
    const base = await compileContexts(
      config,
      [{ nodeId: "node-a", depth: 2, titlesOnly: false }],
      silentLogger,
    );
    const repeated = await compileContexts(
      config,
      [{ nodeId: "node-a", depth: 2, titlesOnly: false }],
      silentLogger,
    );
    const changed = await compileContexts(
      config,
      [{ nodeId: "node-a", depth: 3, titlesOnly: false }],
      silentLogger,
    );

    expect(repeated.manifest.spec_hash).toBe(base.manifest.spec_hash);
    expect(changed.manifest.spec_hash).not.toBe(base.manifest.spec_hash);
  });

  it("merges source manifests and attaches existing page truncation accounting", async () => {
    const first = await compileContexts(
      config,
      [{ nodeId: "agent", depth: 5, titlesOnly: false }],
      silentLogger,
    );
    const second = await compileContexts(
      config,
      [{ nodeId: "folder", depth: 2, titlesOnly: true }],
      silentLogger,
    );
    const pageTruncation = {
      categories: {
        guidance: { limit: 8_000, used: 120, omitted: 0 },
        atom_ref: { limit: 52_000, used: 300, omitted: 1 },
        session_defaults: { limit: 0, used: 0, omitted: 2 },
      },
      total: { limit: 60_000, used: 420, omitted: 1 },
    };

    const merged = mergeContextManifests(
      [first.manifest, second.manifest],
      pageTruncation,
    );

    expect(merged).toMatchObject({
      compiler_version: CONTEXT_COMPILER_VERSION,
      source_count: 2,
      sources: [
        expect.objectContaining({ node_id: "agent" }),
        expect.objectContaining({ node_id: "folder" }),
      ],
      page_context: { truncation: pageTruncation },
    });
    expect(merged.total_chars).toBe(first.manifest.total_chars + second.manifest.total_chars);
  });
});
