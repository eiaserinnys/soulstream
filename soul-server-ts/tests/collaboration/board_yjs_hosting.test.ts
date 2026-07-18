import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BoardYjsHostClient } from "../../src/collaboration/board_yjs_host_client.js";
import { registerBoardYjsHostRoutes } from "../../src/collaboration/board_yjs_host_route.js";
import { createBoardYjsRouting } from "../../src/collaboration/board_yjs_routing.js";
import { BoardYjsService } from "../../src/collaboration/board_yjs_service.js";
import type { SessionDB } from "../../src/db/session_db.js";
import { upsertTaskBoardItem } from "../../src/work-task/task_board_items.js";

function createSilentLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => createSilentLogger(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("board Yjs host centralization", () => {
  it("orch mode routes TaskBoardYjsPort through client and keeps local WS non-host close", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "task:rb-1",
          folderId: "root",
          containerKind: "folder",
          containerId: "root",
          membershipKind: "primary",
          sourceTaskItemId: null,
          itemType: "task",
          itemId: "rb-1",
          x: 10,
          y: 20,
          metadata: {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const routing = createBoardYjsRouting({
      db: {} as SessionDB,
      logger: createSilentLogger() as never,
      auth: {
        authBearerToken: "",
        environment: "development",
        dashboardAuthEnabled: false,
      },
      orch: {
        baseUrl: "http://orch.local",
        headers: { authorization: "Bearer test-token" },
      },
      nodeId: "eiaserinnys",
      hostNodeId: "orch",
    });

    try {
      expect(routing.isBoardYjsHost).toBe(false);
      expect(routing.mutationPort).toBeInstanceOf(BoardYjsHostClient);
      await upsertTaskBoardItem(routing.mutationPort, {
        folderId: "root",
        boardItemId: "task:rb-1",
        taskId: "rb-1",
        title: "Task",
        x: 10,
        y: 20,
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "http://orch.local/api/board-yjs/host/upsert-task-board-item",
        expect.objectContaining({ method: "POST" }),
      );

      const socket = { close: vi.fn() };
      routing.localService.handleContainerConnection(
        socket as never,
        {} as never,
        { containerKind: "folder", containerId: "root" },
      );
      expect(socket.close).toHaveBeenCalledWith(1013, "board Yjs documents are hosted on orch");
    } finally {
      await routing.localService.close();
    }
  });

  it("기존 node id host 값은 local service와 host WS 분기를 유지한다", async () => {
    const routing = createBoardYjsRouting({
      db: {} as SessionDB,
      logger: createSilentLogger() as never,
      auth: {
        authBearerToken: "",
        environment: "development",
        dashboardAuthEnabled: false,
      },
      orch: { baseUrl: "http://orch.local", headers: {} },
      nodeId: "eiaserinnys",
      hostNodeId: "eiaserinnys",
    });
    const handleConnection = vi.fn();
    (routing.localService as unknown as { hocuspocus: { handleConnection: typeof handleConnection } })
      .hocuspocus.handleConnection = handleConnection;

    try {
      expect(routing.isBoardYjsHost).toBe(true);
      expect(routing.mutationPort).toBe(routing.localService);
      routing.localService.handleContainerConnection(
        {} as never,
        {} as never,
        { containerKind: "folder", containerId: "root" },
      );
      expect(handleConnection).toHaveBeenCalledOnce();
    } finally {
      await routing.localService.close();
    }
  });

  it("non-host node refuses direct board document mutation before loading Y.Doc", async () => {
    const service = new BoardYjsService({
      db: {} as SessionDB,
      logger: createSilentLogger() as never,
      nodeId: "worker-node",
      hostNodeId: "host-node",
      isHost: false,
      auth: {
        authBearerToken: "",
        environment: "development",
        dashboardAuthEnabled: false,
      },
    });

    try {
      await expect(
        service.updateBoardItemPosition(
          { containerKind: "folder", containerId: "folder-1" },
          "markdown:doc-1",
          10,
          20,
        ),
      ).rejects.toThrow(
        "board Yjs direct document access is only allowed on host node host-node",
      );
    } finally {
      await service.close();
    }
  });

  it("non-host client delegates board mutations to orch host proxy", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new BoardYjsHostClient({
      orch: {
        baseUrl: "http://orch.local",
        headers: { authorization: "Bearer test-token" },
      },
      logger: createSilentLogger() as never,
    });

    await client.updateBoardItemPosition(
      { containerKind: "task", containerId: "rb-1" },
      "markdown:doc-1",
      120,
      240,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://orch.local/api/board-yjs/host/update-board-item-position");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      authorization: "Bearer test-token",
      "content-type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      container: { containerKind: "task", containerId: "rb-1" },
      boardItemId: "markdown:doc-1",
      x: 120,
      y: 240,
    });
  });

  it("host internal route authenticates and invokes local BoardYjsService port", async () => {
    const service = {
      updateBoardItemPosition: vi.fn().mockResolvedValue(undefined),
    };
    const server = fastify({ logger: false });
    registerBoardYjsHostRoutes(server, {
      service: service as unknown as BoardYjsService,
      auth: {
        authBearerToken: "test-token",
        environment: "production",
        dashboardAuthEnabled: false,
      },
    });

    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/internal/board-yjs/update-board-item-position",
        headers: { authorization: "Bearer test-token" },
        payload: {
          container: { containerKind: "task", containerId: "rb-1" },
          boardItemId: "markdown:doc-1",
          x: 120,
          y: 240,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(service.updateBoardItemPosition).toHaveBeenCalledWith(
        { containerKind: "task", containerId: "rb-1" },
        "markdown:doc-1",
        120,
        240,
      );
    } finally {
      await server.close();
    }
  });

  it("host internal route accepts Bearer-only upsert session requests when dashboard auth is enabled", async () => {
    const boardItem = {
      id: "session:sess-task",
      folderId: "root",
      containerKind: "task",
      containerId: "rb-1",
      membershipKind: "primary",
      sourceTaskItemId: "task-item-1",
      itemType: "session",
      itemId: "sess-task",
      x: 280,
      y: 160,
      metadata: {},
    };
    const service = {
      upsertSessionBoardItem: vi.fn().mockResolvedValue(boardItem),
    };
    const server = fastify({ logger: false });
    registerBoardYjsHostRoutes(server, {
      service: service as unknown as BoardYjsService,
      auth: {
        authBearerToken: "test-token",
        environment: "production",
        dashboardAuthEnabled: true,
        jwtSecret: "jwt-secret",
      },
    });

    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/internal/board-yjs/upsert-session-board-item",
        headers: { authorization: "Bearer test-token" },
        payload: {
          folderId: "root",
          container: { containerKind: "task", containerId: "rb-1" },
          sessionId: "sess-task",
          sourceTaskItemId: "task-item-1",
          x: 280,
          y: 160,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(boardItem);
      expect(service.upsertSessionBoardItem).toHaveBeenCalledWith({
        folderId: "root",
        container: { containerKind: "task", containerId: "rb-1" },
        sessionId: "sess-task",
        sourceTaskItemId: "task-item-1",
        x: 280,
        y: 160,
      });
    } finally {
      await server.close();
    }
  });
});
