import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerContextPreviewRoute } from "../../src/context/context_preview_route.js";
import { AgentRegistry } from "../../src/agent_registry.js";
import { AgentProfileSchema } from "@soulstream/agent-profile-contract";

const auth = {
  authBearerToken: "",
  environment: "development" as const,
  dashboardAuthEnabled: false,
};

describe("context preview route", () => {
  const originalFetch = globalThis.fetch;
  const logger = { warn: vi.fn() };

  beforeEach(() => {
    logger.warn.mockClear();
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input));
      const nodeId = url.pathname.split("/")[3];
      const markdown = url.searchParams.has("titles_only")
        ? `제목 <!-- node:${nodeId} depth:0 -->`
        : "# preview body";
      return new Response(JSON.stringify({ markdown }), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns assembled and per-source markdown alongside instrumentation", async () => {
    const app = Fastify();
    registerContextPreviewRoute(app, {
      nodeId: "eiaserinnys",
      atom: { enabled: true, serverUrl: "https://atom.test", apiKey: "key" },
      auth,
      logger,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/context/preview",
      payload: {
        atom_contexts: [
          {
            node_id: "11111111-2222-3333-4444-555555555555",
            depth: 2,
            applies_when: { source: ["agent"], node_id: ["eiaserinnys"] },
          },
          {
            node_id: "66666666-7777-4888-8999-aaaaaaaaaaaa",
            depth: 1,
            applies_when: { folder_id: ["folder-other"] },
          },
        ],
        session: { source: "agent", folder_id: "folder-current", agent: "seosoyoung" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      manifest: {
        source_count: 2,
        sources: [
          expect.objectContaining({ status: "ok", chars: 14, token_estimate: 4 }),
          expect.objectContaining({ status: "filtered", chars: 0, token_estimate: 0 }),
        ],
      },
    });
    expect(response.json()).toMatchObject({
      assembled: expect.stringContaining("# preview body"),
      sections: [
        { spec_index: 0, title: "제목", markdown: "# preview body" },
        { spec_index: 1, title: "제목", markdown: null },
      ],
      atom_base_url: "https://atom.test",
    });
    // 제목 조회 둘, 부모 노드 조회 둘, 컴파일 하나.
    expect(globalThis.fetch).toHaveBeenCalledTimes(5);
    await app.close();
  });

  it("applies the card_role session field to applies_when", async () => {
    const app = Fastify();
    registerContextPreviewRoute(app, {
      nodeId: "eiaserinnys",
      atom: { enabled: true, serverUrl: "https://atom.test", apiKey: "key" },
      auth,
      logger,
    });
    const preview = async (session: Record<string, unknown>) => (await app.inject({
      method: "POST",
      url: "/api/context/preview",
      payload: {
        atom_contexts: [{ node_id: "11111111-2222-3333-4444-555555555555", depth: 1, applies_when: { card_role: ["assignee"] } }],
        session,
      },
    })).json().manifest.sources[0].status;

    expect(await preview({ card_role: "assignee" })).toBe("ok");
    expect(await preview({ card_role: "member" })).toBe("filtered");
    expect(await preview({})).toBe("filtered");
    await app.close();
  });

  it("rejects malformed atom_contexts before issuing atom requests", async () => {
    const app = Fastify();
    registerContextPreviewRoute(app, {
      nodeId: "eiaserinnys",
      atom: { enabled: true, serverUrl: "https://atom.test", apiKey: "key" },
      auth,
      logger,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/context/preview",
      payload: { atom_contexts: [{ node_id: "not-a-uuid" }] },
    });

    expect(response.statusCode).toBe(422);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await app.close();
  });

  it("resolves profile aliases through the source or the registry and filters by canonical agent", async () => {
    const profile = AgentProfileSchema.parse({
      id: "agent-a", name: "Agent", backend: "claude", workspace_dir: "/tmp",
      aliases: ["alias"],
      atom_contexts: [{ node_id: "11111111-2222-3333-4444-555555555555", applies_when: { agent: ["agent-a"] } }],
    });
    const registry = new AgentRegistry([profile]);
    const resolve = vi.fn(async (id: string) => id === "alias"
      ? { profile, source: "db" as const, stale: false, hasPortrait: false, portraitSource: "none" as const }
      : undefined);
    for (const useSource of [false, true]) {
      const app = Fastify();
      registerContextPreviewRoute(app, {
        nodeId: "eiaserinnys", atom: { enabled: true, serverUrl: "https://atom.test/", apiKey: "key" },
        auth, logger, agentRegistry: useSource ? new AgentRegistry([]) : registry,
        ...(useSource ? { agentProfileSource: { resolve } } : {}),
      });
      const response = await app.inject({ method: "POST", url: "/api/context/preview", payload: {
        agent_id: "alias", session: { agent: "wrong" },
      } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        manifest: { sources: [{ status: "ok" }] },
        sections: [{ spec_index: 0, title: "제목", markdown: "# preview body" }],
        atom_base_url: "https://atom.test",
      });
      await app.close();
    }
    expect(resolve).toHaveBeenCalledWith("alias");
  });

  it("rejects conflicting, missing, and unknown inputs without contacting atom", async () => {
    const app = Fastify();
    registerContextPreviewRoute(app, {
      nodeId: "eiaserinnys", atom: { enabled: true, serverUrl: "https://atom.test", apiKey: "key" },
      auth, logger, agentRegistry: new AgentRegistry([]),
    });
    for (const [payload, status] of [
      [{ atom_contexts: [], agent_id: "agent" }, 422], [{}, 422],
      [{ agent_id: "" }, 422], [{ agent_id: "missing" }, 404],
    ] as const) {
      expect((await app.inject({ method: "POST", url: "/api/context/preview", payload })).statusCode).toBe(status);
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await app.close();
  });

  it("deduplicates identical specs, preserves distinct conditions and filters by backend", async () => {
    const app = Fastify();
    registerContextPreviewRoute(app, {
      nodeId: "eiaserinnys", atom: { enabled: true, serverUrl: "https://atom.test", apiKey: "key" }, auth, logger,
    });
    const spec = { node_id: "11111111-2222-3333-4444-555555555555", applies_when: { backend: ["codex"] } };
    const preview = async (session: object) => (await app.inject({ method: "POST", url: "/api/context/preview", payload: {
      atom_contexts: [spec, spec, { ...spec, applies_when: { backend: ["codex"], source: ["agent"] } }], session,
    } })).json();
    const included = await preview({ backend: "codex", source: "agent" });
    expect(included.manifest.source_count).toBe(2);
    expect(included.manifest.sources.map((source: { status: string }) => source.status)).toEqual(["ok", "ok"]);
    expect(included.sections.map((section: { spec_index: number }) => section.spec_index)).toEqual([0, 2]);
    expect(vi.mocked(globalThis.fetch).mock.calls.filter(([url]) => new URL(String(url)).searchParams.has("titles_only"))).toHaveLength(1);
    const duplicates = (await app.inject({ method: "POST", url: "/api/context/preview", payload: {
      atom_contexts: [spec, spec], session: { backend: "codex" },
    } })).json();
    expect(duplicates.manifest.source_count).toBe(1);
    expect(duplicates.sections).toHaveLength(1);
    expect(duplicates.sections[0].spec_index).toBe(0);
    expect((await preview({})).manifest.sources.map((source: { status: string }) => source.status)).toEqual(["filtered", "filtered"]);
    await app.close();
  });

  it("isolates source and title failures and returns null atom URL when disabled", async () => {
    const first = "11111111-2222-3333-4444-555555555555";
    const second = "66666666-7777-4888-8999-aaaaaaaaaaaa";
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input));
      const isTitle = url.searchParams.has("titles_only");
      if ((url.pathname.includes(first) && isTitle) || (url.pathname.includes(second) && !isTitle)) {
        return new Response("failure", { status: 500 });
      }
      const nodeId = url.pathname.split("/")[3];
      return new Response(JSON.stringify({ markdown: isTitle ? `제목 <!-- node:${nodeId} depth:0 -->` : "# 본문" }));
    }) as typeof fetch;
    const app = Fastify();
    registerContextPreviewRoute(app, {
      nodeId: "eiaserinnys", atom: { enabled: true, serverUrl: "https://atom.test", apiKey: "key" }, auth, logger,
    });
    const payload = { atom_contexts: [{ node_id: first }, { node_id: second }] };
    const result = (await app.inject({ method: "POST", url: "/api/context/preview", payload })).json();
    expect(result.manifest.sources.map((source: { status: string }) => source.status)).toEqual(["ok", "error"]);
    expect(result.sections).toEqual([
      { spec_index: 0, title: null, markdown: "# 본문" },
      { spec_index: 1, title: "제목", markdown: null },
    ]);
    expect(result.assembled).toContain("# 본문");
    await app.close();
    const disabled = Fastify();
    registerContextPreviewRoute(disabled, {
      nodeId: "eiaserinnys", atom: { enabled: false, serverUrl: "https://atom.test", apiKey: "key" }, auth, logger,
    });
    vi.mocked(globalThis.fetch).mockClear();
    const resultDisabled = (await disabled.inject({ method: "POST", url: "/api/context/preview", payload })).json();
    expect(resultDisabled).toMatchObject({ atom_base_url: null, assembled: null, sections: [
      { title: null, markdown: null }, { title: null, markdown: null },
    ] });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await disabled.close();
  });

  it("formats source metadata exactly as it appears in the assembly", async () => {
    const nodeId = "11111111-2222-3333-4444-555555555555";
    const cardId = "66666666-7777-4888-8999-aaaaaaaaaaaa";
    globalThis.fetch = vi.fn(async (input) => {
      const isTitle = new URL(String(input)).searchParams.has("titles_only");
      return new Response(JSON.stringify({ markdown: isTitle
        ? `제목 <!-- node:${nodeId} card:${cardId} depth:0 -->`
        : `# 내용 <!-- node:${nodeId} card:${cardId} depth:0 -->` }));
    }) as typeof fetch;
    const app = Fastify();
    registerContextPreviewRoute(app, {
      nodeId: "eiaserinnys", atom: { enabled: true, serverUrl: "https://atom.test", apiKey: "key" }, auth, logger,
    });
    const result = (await app.inject({ method: "POST", url: "/api/context/preview", payload: {
      atom_contexts: [{ node_id: nodeId }],
    } })).json();
    const markdown = `# 내용 [node:${nodeId} card:${cardId}]`;
    expect(result.sections).toEqual([{ spec_index: 0, title: "제목", markdown }]);
    expect(result.assembled).toContain(markdown);
    await app.close();
  });

  describe("documents, parent_title, ignore_conditions, summary_only", () => {
    const nodeId = "11111111-2222-3333-4444-555555555555";
    const parentId = "99999999-7777-4888-8999-aaaaaaaaaaaa";
    const cardId = "66666666-7777-4888-8999-aaaaaaaaaaaa";
    const sse = (parent: string | null) => new Response(`event: message\ndata: ${JSON.stringify({
      result: { content: [{ type: "text", text: JSON.stringify({ id: nodeId, parent_node_id: parent }) }] },
    })}\n\n`, { status: 200 });

    function serve(opts: { parent: string | null; mcpStatus?: number }): void {
      globalThis.fetch = vi.fn(async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/mcp") {
          return opts.mcpStatus ? new Response("no", { status: opts.mcpStatus }) : sse(opts.parent);
        }
        const id = url.pathname.split("/")[3];
        const titleOnly = url.searchParams.has("titles_only");
        const markdown = id === parentId
          ? `부모 <!-- node:${parentId} depth:0 -->`
          : titleOnly
            ? `제목 <!-- node:${id} card:${cardId} depth:0 chars:7 -->`
            : `# 내용 <!-- node:${id} card:${cardId} depth:0 -->\n본문`;
        void init;
        return new Response(JSON.stringify({ markdown }), { status: 200 });
      }) as typeof fetch;
    }

    async function post(payload: Record<string, unknown>) {
      const app = Fastify();
      registerContextPreviewRoute(app, {
        nodeId: "eiaserinnys", atom: { enabled: true, serverUrl: "https://atom.test", apiKey: "key" }, auth, logger,
      });
      const response = await app.inject({ method: "POST", url: "/api/context/preview", payload });
      await app.close();
      return response;
    }

    it("manifest.sources에 title, parent_title, documents를 더하고 부모는 뿌리마다 한 번만 읽는다", async () => {
      serve({ parent: parentId });
      const spec = { node_id: nodeId, depth: 0 };
      const response = await post({ atom_contexts: [spec, { ...spec, mode: "titles" }] });
      const { manifest, sections } = response.json();
      expect(manifest.sources[0]).toMatchObject({
        title: "제목", parent_title: "부모", status: "ok",
        documents: [{ node_id: nodeId, card_id: cardId, title: "내용", depth: 0, chars: 2 }],
      });
      expect(manifest.sources[1].documents).toEqual([
        { node_id: nodeId, card_id: cardId, title: "제목", depth: 0, chars: 7 },
      ]);
      expect(sections[0]).toEqual({ spec_index: 0, title: "제목", markdown: expect.any(String) });
      const mcpCalls = vi.mocked(globalThis.fetch).mock.calls.filter(([url]) => new URL(String(url)).pathname === "/mcp");
      expect(mcpCalls).toHaveLength(1);
    });

    it("부모가 없거나 조회가 실패하면 parent_title이 null이고 미리보기는 성공한다", async () => {
      for (const opts of [{ parent: null }, { parent: parentId, mcpStatus: 500 }]) {
        serve(opts);
        const response = await post({ atom_contexts: [{ node_id: nodeId }] });
        expect(response.statusCode).toBe(200);
        expect(response.json().manifest.sources[0]).toMatchObject({ parent_title: null, status: "ok" });
      }
    });

    it("조건으로 빠진 소스는 documents가 []이고 ignore_conditions면 채운다", async () => {
      serve({ parent: parentId });
      const payload = {
        atom_contexts: [{ node_id: nodeId, depth: 0, applies_when: { source: ["agent"] } }],
        session: { source: "browser" },
      };
      const filtered = (await post(payload)).json().manifest.sources[0];
      expect(filtered).toMatchObject({ status: "filtered", documents: [], chars: 0 });
      const ignored = (await post({ ...payload, ignore_conditions: true })).json().manifest.sources[0];
      expect(ignored).toMatchObject({
        status: "ok", applies_when: { source: ["agent"] }, documents: [{ node_id: nodeId }],
      });
      expect(ignored.chars).toBeGreaterThan(0);
    });

    it("summary_only는 assembled와 sections[].markdown을 빈 문자열로 돌리고 나머지는 그대로다", async () => {
      serve({ parent: parentId });
      const payload = { atom_contexts: [{ node_id: nodeId, depth: 0 }] };
      const full = (await post(payload)).json();
      const summary = (await post({ ...payload, summary_only: true })).json();
      expect(summary.assembled).toBe("");
      expect(summary.sections).toEqual([{ spec_index: 0, title: "제목", markdown: "" }]);
      expect(summary.manifest).toEqual(full.manifest);
      expect(summary.atom_base_url).toBe(full.atom_base_url);
    });

    it("ignore_conditions와 summary_only가 불리언이 아니면 atom을 부르기 전에 422다", async () => {
      serve({ parent: parentId });
      for (const bad of [{ ignore_conditions: "yes" }, { summary_only: 1 }]) {
        const response = await post({ atom_contexts: [{ node_id: nodeId }], ...bad });
        expect(response.statusCode).toBe(422);
      }
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });
});
