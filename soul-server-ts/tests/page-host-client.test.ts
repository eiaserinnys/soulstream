import { afterEach, describe, expect, it, vi } from "vitest";

import { PageYjsHostClient } from "../src/page/page_host_client.js";

afterEach(() => vi.unstubAllGlobals());

describe("PageYjsHostClient", () => {
  it("uses only the orch host operation endpoint with service bearer headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ page: page(), blocks: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = makeClient();

    await client.getPage("page-1", false);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://orch.local/api/page-yjs/host/get-page");
    expect(init.headers).toEqual({
      authorization: "Bearer service-token",
      "content-type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      page_id: "page-1",
      include_blocks: false,
    });
  });

  it("forwards agent provenance for mutation and lazy-create operations", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(mutationResult()))
      .mockResolvedValueOnce(jsonResponse({ page: page(), created: true }));
    vi.stubGlobal("fetch", fetchMock);
    const client = makeClient();

    await client.createPage({
      page: { id: "page-1", title: "Page", daily_date: null },
      actorSessionId: "session-1",
      idempotencyKey: "create_page:session-1:req",
    });
    await client.getDailyPage({ actorSessionId: "session-1" });

    expect(requestBody(fetchMock, 0)).toMatchObject({
      actor_kind: "agent",
      actor_session_id: "session-1",
      idempotency_key: "create_page:session-1:req",
    });
    expect(requestBody(fetchMock, 1)).toEqual({
      actor_kind: "agent",
      actor_session_id: "session-1",
    });
  });

  it("surfaces the orch structured error without a local fallback", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      detail: { error: { message: "page not found: missing" } },
    }), { status: 404 })));

    await expect(makeClient().getPage("missing", true))
      .rejects.toThrow("page Yjs host get-page failed: page not found: missing");
  });
});

function makeClient() {
  return new PageYjsHostClient({
    orch: {
      baseUrl: "http://orch.local",
      headers: { authorization: "Bearer service-token" },
    },
    logger: { warn: vi.fn() } as never,
  });
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>, index: number) {
  return JSON.parse((fetchMock.mock.calls[index]?.[1] as RequestInit).body as string);
}

function page() {
  return {
    id: "page-1",
    title: "Page",
    daily_date: null,
    version: 1,
    archived: false,
    metadata: {},
    created_at: "2026-07-11T00:00:00.000Z",
    updated_at: "2026-07-11T00:00:00.000Z",
  };
}

function mutationResult() {
  return {
    page: page(),
    blocks: [],
    temp_id_mapping: {},
    operation: { id: "op-1" },
  };
}
