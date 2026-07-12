import pino from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SessionLegacyProjection,
  SessionPageBindingService,
  kstDate,
} from "../../src/page/session_page_binding_service.js";
import type {
  SessionPageBindingRepository,
  SessionPageBindingRow,
} from "../../src/page/session_page_binding_repository.js";

const logger = pino({ level: "silent" });

function binding(overrides: Partial<SessionPageBindingRow> = {}): SessionPageBindingRow {
  return {
    session_id: "sess-1",
    node_id: "node-1",
    target_page_id: null,
    target_block_id: null,
    target_expected_version: null,
    daily_date: "2026-07-13",
    session_type: "claude",
    legacy_folder_id: "folder-1",
    legacy_container_kind: null,
    legacy_container_id: null,
    source_runbook_item_id: null,
    page_state: "pending",
    legacy_state: "pending",
    attempts: 0,
    last_error: null,
    next_retry_at: new Date(0),
    ...overrides,
  };
}

function harness(initial = binding()) {
  let row = initial;
  const repository = {
    enqueue: vi.fn(async () => row),
    get: vi.fn(async () => row),
    listDue: vi.fn(async () => [row]),
    markPageBound: vi.fn(async () => {
      row = {
        ...row,
        page_state: "bound",
        next_retry_at: new Date("2026-07-12T15:30:30.000Z"),
      };
    }),
    markLegacyCompleted: vi.fn(async () => { row = { ...row, legacy_state: "completed" }; }),
    markFailure: vi.fn(async (_id, step, error, manual) => {
      row = {
        ...row,
        ...(step === "page" && manual ? { page_state: "manual_repair" as const } : {}),
        ...(step === "legacy" && manual ? { legacy_state: "manual_repair" as const } : {}),
        last_error: error,
      };
    }),
  } as unknown as SessionPageBindingRepository;
  const pageHost = {
    getDailyPage: vi.fn(async () => ({
      page: { id: "daily-1", title: "2026-07-13", version: 3 },
      created: false,
    })),
    getPage: vi.fn(async () => ({
      page: { id: "page-1", title: "Inbox", version: 7 },
      blocks: [{ id: "block-1" }],
    })),
    batchPageOperations: vi.fn(async () => ({})),
  };
  const legacyProjection = { project: vi.fn(async () => undefined) };
  const service = new SessionPageBindingService({
    nodeId: "node-1",
    repository,
    pageHost: pageHost as never,
    legacyProjection,
    logger,
    now: () => new Date("2026-07-12T15:30:00.000Z"),
  });
  return { service, repository, pageHost, legacyProjection, row: () => row };
}

describe("SessionPageBindingService", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("records KST intent and binds an unanchored session to the daily page", async () => {
    const h = harness();
    await h.service.afterSessionRegistered({
      task: { agentSessionId: "sess-1" } as never,
      params: { agentSessionId: "sess-1", prompt: "start", folderId: "folder-1" },
    });

    expect(h.repository.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "sess-1",
      dailyDate: "2026-07-13",
      targetPageId: null,
    }));
    expect(h.pageHost.batchPageOperations).toHaveBeenCalledWith(expect.objectContaining({
      page_id: "daily-1",
      expected_version: 3,
      idempotency_key: "session-page-binding:sess-1:primary",
      operations: [expect.objectContaining({
        op: "create_block",
        block_type: "session_ref",
        properties: { sessionId: "sess-1", primary: true },
      })],
    }));
    expect(h.legacyProjection.project).not.toHaveBeenCalled();
    await h.service.afterLegacyProjection({
      task: { agentSessionId: "sess-1" } as never,
      params: { agentSessionId: "sess-1", prompt: "start" },
      assignedFolderId: "folder-1",
      completed: true,
    });
    expect(h.row()).toMatchObject({ page_state: "bound", legacy_state: "completed" });
  });

  it("converts an explicit anchor with one CAS batch before projecting legacy state", async () => {
    const h = harness(binding({
      target_page_id: "page-1",
      target_block_id: "block-1",
      target_expected_version: 7,
    }));
    await h.service.reconcile(h.row());

    expect(h.pageHost.batchPageOperations).toHaveBeenCalledWith(expect.objectContaining({
      page_id: "page-1",
      expected_version: 7,
      operations: [
        { op: "update_block_text", block_id: "block-1", text: "[[2026-07-13]]" },
        expect.objectContaining({ op: "update_block_type_and_properties", block_id: "block-1" }),
      ],
    }));
    expect(vi.mocked(h.repository.markPageBound).mock.invocationCallOrder[0]).toBeLessThan(
      h.legacyProjection.project.mock.invocationCallOrder[0]!,
    );
  });

  it("replays the same idempotency key after a crash between page mutation and outbox update", async () => {
    const h = harness();
    vi.mocked(h.repository.markPageBound).mockRejectedValueOnce(new Error("db disconnected"));
    await h.service.reconcile(h.row());
    await h.service.reconcile(h.row());

    expect(h.pageHost.batchPageOperations).toHaveBeenCalledTimes(2);
    const keys = h.pageHost.batchPageOperations.mock.calls.map(([input]) => input.idempotency_key);
    expect(keys).toEqual([
      "session-page-binding:sess-1:primary",
      "session-page-binding:sess-1:primary",
    ]);
    expect(h.row().legacy_state).toBe("completed");
  });

  it("restarts from a durable page-bound row and retries only the failed legacy projection", async () => {
    const h = harness(binding({ page_state: "bound" }));
    h.legacyProjection.project.mockRejectedValueOnce(new Error("board host unavailable"));
    await h.service.reconcileDue();
    await h.service.reconcileDue();

    expect(h.pageHost.batchPageOperations).not.toHaveBeenCalled();
    expect(h.legacyProjection.project).toHaveBeenCalledTimes(2);
    expect(h.row().legacy_state).toBe("completed");
  });

  it("moves a stale explicit anchor to manual repair without retrying legacy projection", async () => {
    const h = harness(binding({
      target_page_id: "page-1",
      target_block_id: "deleted-block",
      target_expected_version: 7,
    }));
    h.pageHost.getPage.mockResolvedValue({ page: { id: "page-1" }, blocks: [] });
    await h.service.reconcile(h.row());

    expect(h.repository.markFailure).toHaveBeenCalledWith(
      "sess-1", "page", "stale page anchor block: deleted-block", true,
    );
    expect(h.legacyProjection.project).not.toHaveBeenCalled();
  });

  it("retries an unanchored daily-page CAS race with the latest page version", async () => {
    const h = harness();
    h.pageHost.getDailyPage
      .mockResolvedValueOnce({ page: { id: "daily-1", title: "2026-07-13", version: 3 }, created: false })
      .mockResolvedValueOnce({ page: { id: "daily-1", title: "2026-07-13", version: 4 }, created: false });
    h.pageHost.batchPageOperations
      .mockRejectedValueOnce(new Error("page version conflict (409)"))
      .mockResolvedValueOnce({});

    await h.service.reconcile(h.row(), true);
    expect(h.repository.markFailure).toHaveBeenCalledWith(
      "sess-1", "page", "page version conflict (409)", false,
    );
    await h.service.reconcile(h.row(), true);

    expect(h.pageHost.batchPageOperations.mock.calls.map(([input]) => input.expected_version))
      .toEqual([3, 4]);
    expect(h.row().page_state).toBe("bound");
  });

  it("eventually binds two concurrent unanchored sessions to the same daily page", async () => {
    const rows = new Map([
      ["sess-a", binding({ session_id: "sess-a", legacy_state: "completed" })],
      ["sess-b", binding({ session_id: "sess-b", legacy_state: "completed" })],
    ]);
    const repository = {
      get: vi.fn(async (sessionId: string) => rows.get(sessionId) ?? null),
      markPageBound: vi.fn(async (sessionId: string) => {
        rows.set(sessionId, { ...rows.get(sessionId)!, page_state: "bound" });
      }),
      markLegacyCompleted: vi.fn(async () => undefined),
      markFailure: vi.fn(async (sessionId: string, step: string, error: string, manual: boolean) => {
        rows.set(sessionId, {
          ...rows.get(sessionId)!,
          ...(step === "page" ? { page_state: manual ? "manual_repair" as const : "pending" as const } : {}),
          last_error: error,
        });
      }),
      listDue: vi.fn(async () => []),
    } as unknown as SessionPageBindingRepository;
    let pageVersion = 3;
    let dailyReads = 0;
    let releaseDaily!: () => void;
    const dailyBarrier = new Promise<void>((resolve) => { releaseDaily = resolve; });
    const pageHost = {
      getDailyPage: vi.fn(async () => {
        const snapshotVersion = pageVersion;
        dailyReads += 1;
        if (dailyReads === 2) releaseDaily();
        await dailyBarrier;
        return { page: { id: "daily-1", title: "2026-07-13", version: snapshotVersion }, created: false };
      }),
      getPage: vi.fn(),
      batchPageOperations: vi.fn(async (input: { expected_version: number }) => {
        if (input.expected_version !== pageVersion) throw new Error("page version conflict (409)");
        pageVersion += 1;
        return {};
      }),
    };
    const service = new SessionPageBindingService({
      nodeId: "node-1",
      repository,
      pageHost: pageHost as never,
      legacyProjection: { project: vi.fn(async () => undefined) },
      logger,
    });

    await Promise.all([
      service.reconcile(rows.get("sess-a")!, true),
      service.reconcile(rows.get("sess-b")!, true),
    ]);
    const retry = [...rows.values()].find((row) => row.page_state === "pending");
    expect(retry).toBeDefined();
    await service.reconcile(retry!, true);

    expect([...rows.values()].map((row) => row.page_state)).toEqual(["bound", "bound"]);
    expect(pageHost.batchPageOperations).toHaveBeenCalledTimes(3);
  });

  it("keeps an explicit pageAnchor CAS conflict in manual repair", async () => {
    const h = harness(binding({
      target_page_id: "page-1",
      target_block_id: "block-1",
      target_expected_version: 7,
    }));
    h.pageHost.batchPageOperations.mockRejectedValueOnce(new Error("page version conflict (409)"));
    await h.service.reconcile(h.row(), true);
    expect(h.repository.markFailure).toHaveBeenCalledWith(
      "sess-1", "page", "page version conflict (409)", true,
    );
  });

  it("serializes hook and stale background work per session and rereads durable state", async () => {
    const h = harness();
    const stale = { ...h.row() };
    vi.mocked(h.repository.listDue).mockResolvedValueOnce([stale]);
    let releasePage!: () => void;
    h.pageHost.batchPageOperations.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releasePage = resolve; });
      return {};
    });

    const hook = h.service.afterSessionRegistered({
      task: { agentSessionId: "sess-1" } as never,
      params: { agentSessionId: "sess-1", prompt: "start" },
    });
    await vi.waitFor(() => expect(h.pageHost.batchPageOperations).toHaveBeenCalledOnce());
    const scan = h.service.reconcileDue();
    await vi.waitFor(() => expect(h.repository.listDue).toHaveBeenCalledOnce());
    releasePage();
    await Promise.all([hook, scan]);

    expect(h.pageHost.batchPageOperations).toHaveBeenCalledOnce();
    expect(h.legacyProjection.project).not.toHaveBeenCalled();
    expect(h.row()).toMatchObject({ page_state: "bound", legacy_state: "pending" });
    await h.service.afterLegacyProjection({
      task: { agentSessionId: "sess-1" } as never,
      params: { agentSessionId: "sess-1", prompt: "start" },
      assignedFolderId: "folder-1",
      completed: true,
    });
    expect(h.repository.markLegacyCompleted).toHaveBeenCalledOnce();
    expect(h.row()).toMatchObject({ page_state: "bound", legacy_state: "completed" });
  });

  it("does not execute a stale pending snapshot after durable page state advanced", async () => {
    const h = harness(binding({
      page_state: "bound",
      next_retry_at: new Date("2026-07-12T15:30:30.000Z"),
    }));
    vi.mocked(h.repository.listDue).mockResolvedValueOnce([binding({ page_state: "pending" })]);
    await h.service.reconcileDue();
    expect(h.pageHost.batchPageOperations).not.toHaveBeenCalled();
    expect(h.legacyProjection.project).not.toHaveBeenCalled();
  });

  it("does not overlap owner-node reconciliation scans", async () => {
    const h = harness(binding({ page_state: "bound", legacy_state: "completed" }));
    let release!: () => void;
    vi.mocked(h.repository.listDue).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return [];
    });
    const first = h.service.reconcileDue();
    await vi.waitFor(() => expect(h.repository.listDue).toHaveBeenCalledOnce());
    await h.service.reconcileDue();
    expect(h.repository.listDue).toHaveBeenCalledOnce();
    release();
    await first;
  });
});

describe("kstDate", () => {
  it("rolls over at Korea midnight", () => {
    expect(kstDate(new Date("2026-07-12T14:59:59.999Z"))).toBe("2026-07-12");
    expect(kstDate(new Date("2026-07-12T15:00:00.000Z"))).toBe("2026-07-13");
  });
});

describe("SessionLegacyProjection", () => {
  it("replays runbook placement into the same first-free grid policy as initial creation", async () => {
    const upsertSessionBoardItem = vi.fn(async () => ({}));
    const db = {
      resolveBoardYjsContainerScope: vi.fn(async () => ({ folderId: "root" })),
      assignSessionToFolder: vi.fn(async () => undefined),
      loadBoardYjsSeed: vi.fn(async () => ({
        boardItems: [{ x: 0, y: 160 }, { x: 280, y: 160 }],
      })),
    };
    const projection = new SessionLegacyProjection(
      db as never,
      { upsertSessionBoardItem } as never,
    );
    await projection.project(binding({
      legacy_folder_id: null,
      legacy_container_kind: "runbook",
      legacy_container_id: "rb-1",
    }));

    expect(upsertSessionBoardItem).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "sess-1",
      x: 560,
      y: 160,
    }));
  });

  it("preserves an existing session board item's coordinates across crash replay", async () => {
    const boardItems: Array<Record<string, unknown> & { x: number; y: number }> = [
      { id: "other", itemId: "other", itemType: "session", x: 0, y: 160 },
    ];
    const calls: Array<{ x: number; y: number }> = [];
    const upsertSessionBoardItem = vi.fn(async (input: { sessionId: string; x: number; y: number }) => {
      calls.push({ x: input.x, y: input.y });
      const existing = boardItems.find((item) => item.id === `session:${input.sessionId}`);
      if (existing) Object.assign(existing, { x: input.x, y: input.y });
      else boardItems.push({
        id: `session:${input.sessionId}`,
        itemId: input.sessionId,
        itemType: "session",
        x: input.x,
        y: input.y,
      });
      return {};
    });
    const db = {
      resolveBoardYjsContainerScope: vi.fn(async () => ({ folderId: "root" })),
      assignSessionToFolder: vi.fn(async () => undefined),
      loadBoardYjsSeed: vi.fn(async () => ({ boardItems: boardItems.map((item) => ({ ...item })) })),
    };
    const projection = new SessionLegacyProjection(db as never, { upsertSessionBoardItem } as never);
    const row = binding({
      legacy_folder_id: null,
      legacy_container_kind: "runbook",
      legacy_container_id: "rb-1",
      page_state: "bound",
    });

    await projection.project(row); // upsert succeeded, outbox completion crashes
    await projection.project(row); // durable replay

    expect(calls).toEqual([{ x: 280, y: 160 }, { x: 280, y: 160 }]);
  });
});
