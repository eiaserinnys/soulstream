import { describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";

import {
  createApp,
  parseOrchServerConfig,
  resolveProductionRouteAuthRequirement,
  type CreateAppOptions,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

describe("production auth guard", () => {
  it("allows a worker service bearer without a cookie", async () => {
    const serviceBearer = "attachment-service-token";
    const metadata = vi.fn(async () => ({
      descriptor: {
        attachment_id: "asset-1",
        name: "report.txt",
        mime_type: "text/plain",
        byte_size: 4,
        checksum_sha256: "c".repeat(64),
        width: null,
        height: null,
        preview_kind: "text" as const,
        preview_mime_type: "text/plain",
      },
      upload_status: "committed" as const,
    }));
    const resolveTokenAccess = vi.fn(async (request: FastifyRequest) =>
      request.headers.authorization === `Bearer ${serviceBearer}` &&
        request.headers.cookie === undefined
        ? { ok: true as const }
        : {
            ok: false as const,
            statusCode: 401,
            detail: "Authorization header required",
          },
    );
    const app = createApp({
      config: parseOrchServerConfig({
        environment: "production",
        databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
        authBearerToken: serviceBearer,
      }),
      productionAuth: { resolveTokenAccess },
      workerAttachmentRoutes: {
        authBearerToken: serviceBearer,
        environment: "production",
        service: {
          metadata,
          content: vi.fn(async () => new Response("content")),
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/attachments/worker/asset-1/metadata?session_id=session-1&mode=input",
      headers: {
        authorization: `Bearer ${serviceBearer}`,
        "x-soulstream-node-id": "node-1",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      descriptor: { attachment_id: "asset-1" },
      upload_status: "committed",
    });
    expect(metadata).toHaveBeenCalledWith({
      attachmentId: "asset-1",
      sessionId: "session-1",
      nodeId: "node-1",
      mode: "input",
    });
    expect(resolveTokenAccess).toHaveBeenCalledOnce();
    await app.close();
  });

  it("allows the service bearer without a cookie and rejects a JWT at the agent route", async () => {
    const serviceBearer = "attachment-service-token";
    const checksum = "c".repeat(64);
    const resolveTokenAccess = vi.fn(async () => ({ ok: true as const }));
    const register = vi.fn(async () => ({
      attachment_id: "asset-1",
      descriptor: {
        attachment_id: "asset-1",
        name: "report.txt",
        mime_type: "text/plain",
        byte_size: 4,
        checksum_sha256: checksum,
        width: null,
        height: null,
        preview_kind: "text",
        preview_mime_type: "text/plain",
      },
    }));
    const app = createApp({
      config: parseOrchServerConfig({
        environment: "production",
        databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
        authBearerToken: serviceBearer,
      }),
      productionAuth: { resolveTokenAccess },
      agentAttachmentRoutes: {
        authBearerToken: serviceBearer,
        environment: "production",
        register,
      },
    } as unknown as CreateAppOptions);

    const request = (authorization: string) => app.inject({
      method: "POST",
      url: `/api/attachments/agent-register?name=report.txt&mime_type=text%2Fplain&byte_size=4&checksum_sha256=${checksum}&card_id=card-1`,
      headers: {
        authorization,
        "content-type": "application/octet-stream",
        "x-soulstream-agent-session-id": "session-1",
        "x-soulstream-node-id": "node-1",
        "x-soulstream-output-command-id": "command-1",
      },
      payload: Buffer.from("test"),
    });

    const serviceResponse = await request(`Bearer ${serviceBearer}`);
    expect(serviceResponse.statusCode).toBe(200);
    expect(resolveTokenAccess).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledOnce();

    const jwtResponse = await request("Bearer dashboard-jwt");
    expect(jwtResponse.statusCode).toBe(401);
    expect(jwtResponse.json()).toMatchObject({ code: "ATTACHMENT_UNAUTHORIZED" });
    expect(resolveTokenAccess).toHaveBeenCalledTimes(2);

    await app.close();
  });

  it("enforces protected routes and exempts public routes from the auth matrix", async () => {
    const resolveTokenAccess = vi.fn(async () => ({
      ok: false as const,
      statusCode: 401,
      detail: "Authorization header required",
    }));
    const app = createApp({
      config,
      productionAuth: { resolveTokenAccess },
      publicStatusRoutes: createPublicStatusRouteOptions(),
    });

    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(resolveTokenAccess).not.toHaveBeenCalled();

    const healthHead = await app.inject({ method: "HEAD", url: "/api/health" });
    expect(healthHead.statusCode).toBe(200);
    expect(resolveTokenAccess).not.toHaveBeenCalled();

    const status = await app.inject({ method: "GET", url: "/api/status" });
    expect(status.statusCode).toBe(401);
    expect(status.json()).toEqual({ detail: "Authorization header required" });
    expect(resolveTokenAccess).toHaveBeenCalledTimes(1);

    const statusHead = await app.inject({ method: "HEAD", url: "/api/status" });
    expect(statusHead.statusCode).toBe(401);
    expect(resolveTokenAccess).toHaveBeenCalledTimes(2);

    await app.close();
  });

  it("leaves individual opt-in test harnesses unchanged when the guard is omitted", async () => {
    const app = createApp({
      config,
      publicStatusRoutes: createPublicStatusRouteOptions(),
    });

    const status = await app.inject({ method: "GET", url: "/api/status" });
    expect(status.statusCode).toBe(200);

    await app.close();
  });

  it("rejects an unlisted route by default", async () => {
    const app = createApp({
      config,
      productionAuth: {
        resolveTokenAccess: vi.fn(async () => ({
          ok: false as const,
          statusCode: 401,
          detail: "Authorization header required",
        })),
      },
    });
    app.get("/api/unlisted", async () => ({ public: true }));

    const response = await app.inject({ method: "GET", url: "/api/unlisted" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ detail: "Authorization header required" });
    await app.close();
  });

  it("uses protocol-aware matrix keys for SSE, public HTTP, and WebSocket routes", () => {
    expect(resolveProductionRouteAuthRequirement({
      method: "GET",
      routeUrl: "/api/sessions/stream",
    })).toBe(true);
    expect(resolveProductionRouteAuthRequirement({
      method: "GET",
      routeUrl: "/api/sessions/:session_id/background-tasks",
    })).toBe(true);
    expect(resolveProductionRouteAuthRequirement({
      method: "GET",
      routeUrl: "/api/health",
    })).toBe(false);
    expect(resolveProductionRouteAuthRequirement({
      method: "GET",
      routeUrl: "/ws/node",
      websocket: true,
    })).toBe(false);
    expect(resolveProductionRouteAuthRequirement({
      method: "GET",
      routeUrl: "/yjs/:folderId",
      websocket: true,
    })).toBe(false);
    expect(resolveProductionRouteAuthRequirement({
      method: "GET",
      routeUrl: "/yjs/:containerKind/:containerId",
      websocket: true,
    })).toBeUndefined();
    for (const [method, routeUrl] of [
      ["GET", "/api/pages"],
      ["POST", "/api/pages/daily"],
      ["GET", "/api/pages/:pageId"],
      ["GET", "/api/pages/search"],
      ["GET", "/api/pages/:pageId/backlinks"],
      ["POST", "/api/pages/:pageId/operations"],
      ["PATCH", "/api/pages/:pageId/starred"],
    ] as const) {
      expect(resolveProductionRouteAuthRequirement({ method, routeUrl })).toBe(true);
    }
  });
});

function createPublicStatusRouteOptions() {
  return {
    configProvider: {
      getConfig: () => ({
        authEnabled: true,
        atomEnabled: false,
      }),
    },
    folderCountsProvider: {
      getFolderCounts: () => new Map<string | null, number>(),
      listFolders: () => [],
      resolveAccess: () => ({ restricted: false }),
    },
  };
}
