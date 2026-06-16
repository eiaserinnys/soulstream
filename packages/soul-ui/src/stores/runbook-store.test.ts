import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type RunbookSnapshot, useRunbookStore } from "./runbook-store";

const originalFetch = globalThis.fetch;

function snapshot(title: string): RunbookSnapshot {
  return {
    runbook: {
      id: "rb-1",
      board_item_id: "runbook:rb-1",
      folder_id: "f1",
      title,
      archived: false,
      version: 1,
      created_session_id: null,
      created_event_id: null,
      created_at: "2026-06-16T00:00:00+00:00",
      updated_at: "2026-06-16T00:00:00+00:00",
    },
    sections: [],
    items: [],
  };
}

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe("runbook-store", () => {
  beforeEach(() => {
    useRunbookStore.getState().reset();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("loads a runbook snapshot from the read-only API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(snapshot("Launch")));
    globalThis.fetch = fetchMock;

    const result = await useRunbookStore.getState().loadRunbook("rb-1");

    expect(fetchMock.mock.calls[0][0]).toBe("/api/runbooks/rb-1");
    expect(result?.runbook.title).toBe("Launch");
    expect(useRunbookStore.getState().byId["rb-1"].snapshot?.runbook.title).toBe("Launch");
  });

  it("reloads an observed runbook when runbook_updated arrives", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse(snapshot("Before")))
      .mockResolvedValueOnce(okResponse(snapshot("After")));
    globalThis.fetch = fetchMock;

    await useRunbookStore.getState().loadRunbook("rb-1");
    await useRunbookStore.getState().handleRunbookUpdated({
      type: "runbook_updated",
      runbookId: "rb-1",
      boardItemId: "runbook:rb-1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useRunbookStore.getState().byId["rb-1"].snapshot?.runbook.title).toBe("After");
  });

  it("does not fetch unseen runbooks on broadcast", () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    const result = useRunbookStore.getState().handleRunbookUpdated({
      type: "runbook_updated",
      runbookId: "rb-unseen",
      boardItemId: "runbook:rb-unseen",
    });

    expect(result).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
