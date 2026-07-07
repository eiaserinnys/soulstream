import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BoardYjsHostClient } from "../../src/collaboration/board_yjs_host_client.js";
import { registerBoardYjsHostRoutes } from "../../src/collaboration/board_yjs_host_route.js";
import { BoardYjsService } from "../../src/collaboration/board_yjs_service.js";
import type { SessionDB } from "../../src/db/session_db.js";

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
      { containerKind: "runbook", containerId: "rb-1" },
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
      container: { containerKind: "runbook", containerId: "rb-1" },
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
          container: { containerKind: "runbook", containerId: "rb-1" },
          boardItemId: "markdown:doc-1",
          x: 120,
          y: 240,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(service.updateBoardItemPosition).toHaveBeenCalledWith(
        { containerKind: "runbook", containerId: "rb-1" },
        "markdown:doc-1",
        120,
        240,
      );
    } finally {
      await server.close();
    }
  });
});
