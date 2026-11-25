import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAgentPortraitStore } from "./agent-portrait-store";

const sha = "a".repeat(64);
const body = { portraits: [{ agent_id: "roselin", sha256: sha, mime: "image/png", byte_size: 1, updated_at: "x", url: `/api/agent-portraits/roselin?v=${sha}` }] };

describe("agent portrait store", () => {
  beforeEach(() => {
    useAgentPortraitStore.setState({ loaded: false, etag: null, lastFetchedAt: 0, dictionary: new Map() });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("loads the list, then sends the received ETag and keeps the dictionary on 304", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200, headers: { ETag: '"list-1"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    vi.stubGlobal("fetch", fetchMock);

    await useAgentPortraitStore.getState().refresh();
    expect(useAgentPortraitStore.getState().loaded).toBe(true);
    expect(useAgentPortraitStore.getState().dictionary.get("roselin")?.sha256).toBe(sha);

    const before = useAgentPortraitStore.getState().dictionary;
    await useAgentPortraitStore.getState().refresh();
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ headers: { "If-None-Match": '"list-1"' } });
    expect(useAgentPortraitStore.getState().dictionary).toBe(before);
  });

  it("stays unloaded when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    await useAgentPortraitStore.getState().refresh();

    expect(useAgentPortraitStore.getState().loaded).toBe(false);
  });
});
