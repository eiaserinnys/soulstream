import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerContextPreviewRoute } from "../../src/context/context_preview_route.js";

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
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ markdown: "# preview body" }), { status: 200 })) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("dry-runs the real compiler and returns per-source instrumentation without markdown", async () => {
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
    expect(response.body).not.toContain("preview body");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
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
});
