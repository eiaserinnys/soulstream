import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type RunbookOverviewPayload,
  type RunbookSnapshot,
  useRunbookStore,
} from "./runbook-store";

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

function overview(title: string): RunbookOverviewPayload {
  return {
    my_turn_items: [
      {
        runbook_id: "rb-1",
        runbook_title: title,
        board_item_id: "runbook:rb-1",
        folder_id: "f1",
        section_id: "sec-1",
        section_title: "Release",
        item_id: "item-1",
        item_title: "Check handoff",
        how_to: "",
        status: "pending",
        item_version: 1,
        effective_assignee_kind: "human",
        effective_assignee_agent_id: null,
        effective_assignee_session_id: null,
        effective_assignee_user_id: "operator@example.com",
      },
    ],
    runbooks: [],
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

  it("loads the runbook overview from the my-turn API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(overview("Launch")));
    globalThis.fetch = fetchMock;

    const result = await useRunbookStore.getState().loadOverview();

    expect(fetchMock.mock.calls[0][0]).toBe("/api/runbooks/my-turn");
    expect(result.my_turn_items[0]?.runbook_title).toBe("Launch");
    expect(useRunbookStore.getState().overview.snapshot?.my_turn_items).toHaveLength(1);
  });

  it("posts item status mutations with credentials and stores the returned projection", async () => {
    const nextSnapshot = snapshot("After status");
    const fetchMock = vi.fn().mockResolvedValue(okResponse({
      ok: true,
      snapshot: nextSnapshot,
    }));
    globalThis.fetch = fetchMock;

    const result = await useRunbookStore.getState().setItemStatus({
      runbookId: "rb-1",
      itemId: "item-1",
      expectedVersion: 3,
      status: "completed",
      idempotencyKey: "runbook:rb-1:item:item-1:status:completed:v3:test",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runbooks/rb-1/items/item-1/status",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toEqual({
      status: "completed",
      expectedVersion: 3,
      idempotencyKey: "runbook:rb-1:item:item-1:status:completed:v3:test",
    });
    expect(result?.runbook.title).toBe("After status");
    expect(useRunbookStore.getState().byId["rb-1"].snapshot?.runbook.title).toBe("After status");
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

  it("reloads an observed overview when runbook_updated arrives", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse(overview("Before")))
      .mockResolvedValueOnce(okResponse(overview("After")));
    globalThis.fetch = fetchMock;

    await useRunbookStore.getState().loadOverview();
    await useRunbookStore.getState().handleRunbookUpdated({
      type: "runbook_updated",
      runbookId: "rb-1",
      boardItemId: "runbook:rb-1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useRunbookStore.getState().overview.snapshot?.my_turn_items[0]?.runbook_title).toBe("After");
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
