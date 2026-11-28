import pino from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SessionLegacyProjection,
  SessionPageBindingService,
} from "../../src/page/session_page_binding_service.js";
import type { SessionPageBindingRow } from "@soulstream/mcp-contract";
import type { SessionPageBindingHostClient } from "../../src/control_plane/persistence_host_clients.js";

const logger = pino({ level: "silent" });

function binding(overrides: Partial<SessionPageBindingRow> = {}): SessionPageBindingRow {
  return {
    session_id: "sess-1",
    node_id: "node-1",
    target_page_id: null,
    target_block_id: null,
    target_expected_version: null,
    session_type: "claude",
    legacy_folder_id: "folder-1",
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
    enqueue: vi.fn(async (input) => { row = { ...row, page_state: input.initialPageState }; return row; }),
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
  } as unknown as SessionPageBindingHostClient;
  const pageHost = {
    getDailyPage: vi.fn(async () => ({
      page: { id: "daily-1", title: "2026-07-13", version: 3 },
      created: false,
    })),
    getPage: vi.fn(async () => ({
      page: { id: "page-1", title: "Inbox", version: 7 },
      blocks: [{ id: "block-1" }],
    })),
    batchPageOperations: vi.fn(async (_input: { idempotency_key?: string; expected_version?: number }) => ({})),
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

  it("excludes an unanchored browser session from page binding", async () => {
    const h = harness();
    const hookParams = {
      task: { agentSessionId: "sess-1" } as never,
      params: {
        agentSessionId: "sess-1",
        prompt: "start",
        folderId: "folder-1",
        callerInfo: { source: "browser" },
      },
    };
    await h.service.persistCreationIntent(hookParams);
    await h.service.afterSessionRegistered(hookParams);

    expect(h.repository.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "sess-1",
      targetPageId: null,
      initialPageState: "bound",
    }));
    expect(h.pageHost.getDailyPage).not.toHaveBeenCalled();
    expect(h.pageHost.batchPageOperations).not.toHaveBeenCalled();
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

    expect(h.pageHost.getDailyPage).not.toHaveBeenCalled();
    expect(h.pageHost.batchPageOperations).toHaveBeenCalledWith(expect.objectContaining({
      page_id: "page-1",
      expected_version: 7,
      operations: [expect.objectContaining({
        op: "update_block_type_and_properties",
        block_id: "block-1",
      })],
    }));
    expect(vi.mocked(h.repository.markPageBound).mock.invocationCallOrder[0]).toBeLessThan(
      h.legacyProjection.project.mock.invocationCallOrder[0]!,
    );
  });

  it("projects the folder for an old unanchored pending binding", async () => {
    const h = harness(binding({ target_page_id: null, page_state: "pending", legacy_state: "pending" }));
    await h.service.reconcileDue();
    expect(h.repository.markPageBound).toHaveBeenCalledWith("sess-1");
    expect(h.legacyProjection.project).toHaveBeenCalledWith(expect.objectContaining({
      session_id: "sess-1", page_state: "bound", legacy_folder_id: "folder-1",
    }));
    expect(vi.mocked(h.repository.markPageBound).mock.invocationCallOrder[0]).toBeLessThan(
      h.legacyProjection.project.mock.invocationCallOrder[0]!,
    );
    expect(h.row()).toMatchObject({ page_state: "bound", legacy_state: "completed" });
  });

  it.each([
    {
      name: "delegated agent source",
      params: { callerInfo: { source: "agent" } },
    },
    {
      name: "unknown source",
      params: {},
    },
  ])("keeps $name out of daily while preserving durable legacy projection", async ({ params }) => {
    const h = harness(binding({ page_state: "bound" }));
    const hookParams = {
      task: { agentSessionId: "sess-1" } as never,
      params: { agentSessionId: "sess-1", prompt: "start", ...params } as never,
    };
    await h.service.persistCreationIntent(hookParams);
    await h.service.afterSessionRegistered(hookParams);

    expect(h.repository.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "sess-1",
      initialPageState: "bound",
    }));
    expect(h.pageHost.getDailyPage).not.toHaveBeenCalled();
    expect(h.pageHost.batchPageOperations).not.toHaveBeenCalled();

    await h.service.afterLegacyProjection({
      task: { agentSessionId: "sess-1" } as never,
      params: { agentSessionId: "sess-1", prompt: "start" },
      assignedFolderId: "folder-1",
      completed: true,
    });
    expect(h.repository.markLegacyCompleted).toHaveBeenCalledOnce();
  });

  it("replays the same idempotency key after a crash between page mutation and outbox update", async () => {
    const h = harness(binding({ target_page_id: "page-1", target_block_id: "block-1", target_expected_version: 7 }));
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
    h.pageHost.getPage.mockResolvedValue({ page: { id: "page-1", title: "Inbox", version: 7 }, blocks: [] });
    await h.service.reconcile(h.row());

    expect(h.repository.markFailure).toHaveBeenCalledWith(
      "sess-1", "page", "stale page anchor block: deleted-block", true,
    );
    expect(h.legacyProjection.project).not.toHaveBeenCalled();
  });

  it("keeps an explicit pageAnchor CAS conflict in manual repair", async () => {
    const h = harness(binding({
      target_page_id: "page-1",
      target_block_id: "block-1",
      target_expected_version: 7,
    }));
    h.pageHost.batchPageOperations.mockRejectedValueOnce(new Error("page version conflict (409)"));
    const task = { agentSessionId: "sess-1" } as never;
    const hookParams = {
      task,
      params: {
        agentSessionId: "sess-1",
        prompt: "start",
        pageAnchor: { pageId: "page-1", blockId: "block-1", expectedVersion: 7 },
      },
    };
    await h.service.persistCreationIntent(hookParams);
    await h.service.afterSessionRegistered(hookParams);
    expect(h.repository.markFailure).toHaveBeenCalledWith(
      "sess-1", "page", "page version conflict (409)", true,
    );
    expect(task).toMatchObject({
      creationWarnings: [expect.objectContaining({ code: "PAGE_BINDING_MANUAL_REPAIR" })],
    });
  });

  it("reports a failed legacy projection without cancelling the created task", async () => {
    const h = harness(binding({ page_state: "bound" }));
    const task = { agentSessionId: "sess-1" } as never;
    await h.service.afterLegacyProjection({
      task,
      params: { agentSessionId: "sess-1", prompt: "start" },
      assignedFolderId: null,
      completed: false,
    });
    expect(task).toMatchObject({
      creationWarnings: [expect.objectContaining({ code: "LEGACY_PROJECTION_PENDING" })],
    });
  });

  it("serializes hook and stale background work per session and rereads durable state", async () => {
    const h = harness(binding({ target_page_id: "page-1", target_block_id: "block-1", target_expected_version: 7 }));
    const stale = { ...h.row() };
    vi.mocked(h.repository.listDue).mockResolvedValueOnce([stale]);
    let releasePage!: () => void;
    h.pageHost.batchPageOperations.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releasePage = resolve; });
      return {};
    });

    const hookParams = {
      task: { agentSessionId: "sess-1" } as never,
      params: { agentSessionId: "sess-1", prompt: "start", pageAnchor: { pageId: "page-1", blockId: "block-1", expectedVersion: 7 } },
    };
    await h.service.persistCreationIntent(hookParams);
    const hook = h.service.afterSessionRegistered(hookParams);
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

describe("SessionLegacyProjection", () => {
  it("replays folder placement through the flat folder host", async () => {
    const moveSessionToFolder = vi.fn(async (_sessionId: string, _folderId: string | null) => undefined);
    const db = { getFolderById: vi.fn(async () => ({ id: "folder-1" })),
      getBoardItemsByFolder: vi.fn(async () => []) };
    const projection = new SessionLegacyProjection(db as never, { moveSessionToFolder } as never);
    await projection.project(binding({ legacy_folder_id: "folder-1" }));
    expect(moveSessionToFolder).toHaveBeenCalledWith("sess-1", "folder-1");
    expect(db.getBoardItemsByFolder).not.toHaveBeenCalled();
  });

  it("assigns the folder without reading board coordinates", async () => {
    const moveSessionToFolder = vi.fn(async (_sessionId: string, _folderId: string | null) => undefined);
    const db = { getFolderById: vi.fn(async () => ({ id: "rb-1" })),
      getBoardItemsByFolder: vi.fn(async () => [{ x: 0, y: 160 }, { x: 280, y: 160 }]) };
    const projection = new SessionLegacyProjection(db as never, { moveSessionToFolder } as never);
    await projection.project(binding({ legacy_folder_id: "rb-1" }));
    expect(moveSessionToFolder).toHaveBeenCalledWith("sess-1", "rb-1");
    expect(db.getBoardItemsByFolder).not.toHaveBeenCalled();
  });

  it("replays the same session and folder after a completion crash", async () => {
    const moveSessionToFolder = vi.fn(async (_sessionId: string, _folderId: string | null) => undefined);
    const db = { getFolderById: vi.fn(async () => ({ id: "rb-1" })),
      getBoardItemsByFolder: vi.fn(async () => []) };
    const projection = new SessionLegacyProjection(db as never, { moveSessionToFolder } as never);
    const row = binding({ legacy_folder_id: "rb-1", page_state: "bound" });
    await projection.project(row);
    await projection.project(row);
    expect(moveSessionToFolder.mock.calls).toEqual([["sess-1", "rb-1"], ["sess-1", "rb-1"]]);
    expect(db.getBoardItemsByFolder).not.toHaveBeenCalled();
  });
});
