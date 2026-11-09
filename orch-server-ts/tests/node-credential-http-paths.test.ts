import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { registerMcpHostRoutes } from "../src/mcp/mcp_host_routes.js";
import { registerWorkerAttachmentRoutes } from "../src/attachments/worker_attachment_routes.js";
import { registerSessionCommandRoutes } from "../src/session/session_command_routes.js";
import type {
  NodeCredentialResolver,
  NodePrincipal,
} from "../src/node_credentials/types.js";
import { unusedClusterDependencies } from "./mcp-cluster-unused-fixture.js";

const PRINCIPAL: NodePrincipal = {
  credential_id: "credential-1",
  node_id: "fake-node",
  company_pc: false,
};

function createFakeNodeCredentials() {
  let active = true;
  const resolver: NodeCredentialResolver = {
    resolve: (token) => (active && token === "node-token" ? PRINCIPAL : null),
    onRevoked: () => () => {},
  };
  return {
    resolver,
    revoke: () => {
      active = false;
    },
  };
}

const cards = {
  provider: { listFolders: () => [], listSessionAssignments: () => ({}) },
  resolveAccess: () => ({ restricted: false, allowedFolderIds: [] }),
};

describe("node credential tokens on HTTP service routes", () => {
  it("passes the MCP host boundary with a node token and rejects it after revocation", async () => {
    const credentials = createFakeNodeCredentials();
    const app = Fastify();
    registerMcpHostRoutes(app, {
      ...unusedClusterDependencies,
      board: undefined as never,
      authBearerToken: "service-token",
      nodeCredentials: credentials.resolver,
      cards,
      folders: {
        authBearerToken: "service-token",
        nodeCredentials: credentials.resolver,
        serviceProvider: vi.fn(),
      },
    });

    const context = { principal: "internal", caller_session_id: null, node_id: "node" };
    const accepted = await app.inject({
      method: "POST",
      url: "/api/mcp/host/unknown",
      headers: { authorization: "Bearer node-token" },
      payload: { args: {}, context },
    });
    expect(accepted.statusCode).toBe(404);

    credentials.revoke();
    const revoked = await app.inject({
      method: "POST",
      url: "/api/mcp/host/unknown",
      headers: { authorization: "Bearer node-token" },
      payload: { args: {}, context },
    });
    expect(revoked.statusCode).toBe(401);

    await app.close();
  });

  it("passes the worker attachment boundary with a node token", async () => {
    const credentials = createFakeNodeCredentials();
    const app = Fastify();
    const metadata = vi.fn(async () => ({ attachment_id: "att-1" }));
    registerWorkerAttachmentRoutes(app, {
      authBearerToken: "service-token",
      environment: "production",
      nodeCredentials: credentials.resolver,
      service: { metadata, content: vi.fn() } as never,
    });

    const accepted = await app.inject({
      method: "GET",
      url: "/api/attachments/worker/att-1/metadata?session_id=session-1&mode=input",
      headers: {
        authorization: "Bearer node-token",
        "x-soulstream-node-id": "fake-node",
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ attachment_id: "att-1" });
    expect(metadata).toHaveBeenCalledWith({
      sessionId: "session-1",
      nodeId: "fake-node",
      attachmentId: "att-1",
      mode: "input",
    });

    const unknown = await app.inject({
      method: "GET",
      url: "/api/attachments/worker/att-1/metadata?session_id=session-1&mode=input",
      headers: {
        authorization: "Bearer unknown-token",
        "x-soulstream-node-id": "fake-node",
      },
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toMatchObject({ code: "ATTACHMENT_UNAUTHORIZED" });

    await app.close();
  });

  it("passes the session worktree service-bearer check with a node token", async () => {
    const credentials = createFakeNodeCredentials();
    const app = Fastify();
    registerSessionCommandRoutes(app, {
      nodeCredentials: credentials.resolver,
      router: {} as never,
      bridge: {} as never,
      worktreeAuthBearerToken: "service-token",
      environment: "production",
    });

    const accepted = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { authorization: "Bearer node-token" },
      payload: { prompt: "hello", worktree_id: "worktree-1" },
    });
    expect(accepted.statusCode).toBe(400);
    expect(accepted.json()).toMatchObject({
      error: {
        code: "INVALID_REQUEST",
        message: "worktree_actor_session_id is required for worktree-bound sessions",
      },
    });

    credentials.revoke();
    const rejected = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { authorization: "Bearer node-token" },
      payload: { prompt: "hello", worktree_id: "worktree-1", worktree_actor_session_id: "caller-1" },
    });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json()).toMatchObject({
      error: { code: "WORKTREE_INTERNAL_AUTH_REQUIRED" },
    });

    await app.close();
  });
});
