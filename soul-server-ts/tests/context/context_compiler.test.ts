import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { compileContexts } from "../../src/context/compiler/index.js";
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
        legacy: golden.spec,
      });
      expect(compiled.manifest).toBeNull();
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
});
