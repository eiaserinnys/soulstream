import { isRecord } from "@soulstream/wire-schema/json-record";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireAdmin, type AdminAccessProvider } from "../admin/admin_access.js";
import { invalidInput, McpCentralError } from "./errors.js";
import type { McpCentralService } from "./service.js";

export type McpCentralRouteOptions = {
  service: McpCentralService;
  provider: AdminAccessProvider;
  actions?: { test: (body: unknown) => Promise<unknown>; preview: (agentId: string, nodeId: string, profileId?: string) => Promise<unknown> };
  onConfigWritten?: () => void;
  nodeStatus?: (nodeId: string) => { connected: boolean; central_sync_supported: boolean; ack: { revision: number } | null };
};

export const mcpCentralRouteAuthRequirements = {
  "GET /api/mcp/config": true,
  "POST /api/mcp/servers/test": true,
  "GET /api/mcp/agents/{agent_id}/preview": true,
  "PUT /api/mcp/managed-nodes/{node_id}": true,
  "DELETE /api/mcp/managed-nodes/{node_id}": true,
  "PUT /api/mcp/servers/{server_id}": true,
  "DELETE /api/mcp/servers/{server_id}": true,
  "POST /api/mcp/server-icons": true,
  "GET /api/mcp/server-icons/{ref}": true,
  "PUT /api/mcp/profiles/{profile_id}": true,
  "DELETE /api/mcp/profiles/{profile_id}": true,
  "PUT /api/mcp/agents/{agent_id}": true,
  "PUT /api/mcp/secrets/{name}": true,
  "DELETE /api/mcp/secrets/{name}": true,
  "GET /api/mcp/revisions": true,
  "POST /api/mcp/revisions/{revision_id}/rollback": true,
};

type Params = Record<string, string>;
type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

export function registerMcpCentralRoutes(app: FastifyInstance, options: McpCentralRouteOptions): void {
  const { service, provider } = options;
  const guarded = (handler: Handler): Handler => async (request, reply) => {
    if (await requireAdmin(request, reply, provider) === undefined) return reply;
    try {
      return await handler(request, reply);
    } catch (error) {
      const known = error instanceof McpCentralError;
      const code = known ? error.code : "MCP_INTERNAL_ERROR";
      const message = known ? error.message : "internal error";
      request.log.error({ name: error instanceof Error ? error.name : "Error", code, message }, "MCP central request failed");
      return reply.code(known ? error.statusCode : 500).send({ code, message });
    }
  };
  const params = (request: FastifyRequest): Params => request.params as Params;

  app.post("/api/mcp/servers/test", guarded(async (request) => {
    if (!options.actions) throw new McpCentralError("MCP_NODE_UNAVAILABLE", 503, "MCP test unavailable");
    return options.actions.test(request.body);
  }));
  app.get("/api/mcp/agents/:agent_id/preview", guarded(async (request) => {
    if (!options.actions) throw new McpCentralError("MCP_NODE_UNAVAILABLE", 503, "MCP preview unavailable");
    const query = isRecord(request.query) ? request.query : {};
    if (typeof query.node_id !== "string" || !query.node_id || (query.mcp_profile_id !== undefined && (typeof query.mcp_profile_id !== "string" || !query.mcp_profile_id))) throw invalidInput("node_id and mcp_profile_id must be non-empty strings");
    return options.actions.preview(params(request).agent_id!, query.node_id, query.mcp_profile_id as string | undefined);
  }));

  app.get("/api/mcp/config", guarded(async () => {
    const config = await service.getConfig();
    return { ...config, managed_nodes: config.managed_nodes?.map(node => ({ ...node,
      ...(options.nodeStatus?.(node.node_id) ?? { connected: false, central_sync_supported: false, ack: null }),
    })) };
  }));
  app.put("/api/mcp/managed-nodes/:node_id", guarded(async (request) => {
    const { write } = bodyAndWrite(request.body);
    const { current_revision } = await service.addManagedNode(params(request).node_id, write);
    options.onConfigWritten?.();
    return { current_revision };
  }));
  app.delete("/api/mcp/managed-nodes/:node_id", guarded(async (request) => {
    const { current_revision } = await service.removeManagedNode(params(request).node_id, queryWrite(request.query));
    options.onConfigWritten?.();
    return { current_revision };
  }));
  app.put("/api/mcp/servers/:server_id", guarded(async (request) => {
    const { body, write } = bodyAndWrite(request.body);
    const { current_revision, result } = await service.putServer(params(request).server_id, body, write);
    options.onConfigWritten?.();
    return { current_revision, server: result };
  }));
  app.delete("/api/mcp/servers/:server_id", guarded(async (request) => {
    const { current_revision } = await service.deleteServer(params(request).server_id, queryWrite(request.query));
    options.onConfigWritten?.();
    return { current_revision };
  }));
  app.post("/api/mcp/server-icons", { bodyLimit: 524288 }, guarded(async (request) => service.uploadServerIcon(request.body)));
  app.get("/api/mcp/server-icons/:ref", guarded(async (request, reply) => {
    const icon = await service.getServerIcon(params(request).ref);
    if (icon === null) return reply.code(404).send({ code: "MCP_ICON_NOT_FOUND", message: "icon not found" });
    const etag = `"${icon.content_hash}"`;
    reply.header("ETag", etag).header("Cache-Control", "private, max-age=31536000, immutable")
      .header("X-Content-Type-Options", "nosniff").type(icon.mime);
    if (request.headers["if-none-match"] === etag) return reply.code(304).send();
    return reply.send(icon.body);
  }));
  app.put("/api/mcp/profiles/:profile_id", guarded(async (request) => {
    const { body, write } = bodyAndWrite(request.body);
    const { current_revision, result } = await service.putProfile(params(request).profile_id, body, write);
    options.onConfigWritten?.();
    return { current_revision, profile: result };
  }));
  app.delete("/api/mcp/profiles/:profile_id", guarded(async (request) => {
    const { current_revision } = await service.deleteProfile(params(request).profile_id, queryWrite(request.query));
    options.onConfigWritten?.();
    return { current_revision };
  }));
  app.put("/api/mcp/agents/:agent_id", guarded(async (request) => {
    const { body, write } = bodyAndWrite(request.body);
    const { current_revision, result } = await service.setAgentBindings(params(request).agent_id, body, write);
    options.onConfigWritten?.();
    return { current_revision, bindings: result };
  }));
  app.put("/api/mcp/secrets/:name", guarded(async (request) => {
    const { body, write } = bodyAndWrite(request.body);
    const { current_revision, result } = await service.putSecret(params(request).name, body.value, write);
    options.onConfigWritten?.();
    return { current_revision, secret: result };
  }));
  app.delete("/api/mcp/secrets/:name", guarded(async (request) => {
    const { current_revision } = await service.deleteSecret(params(request).name, queryWrite(request.query));
    options.onConfigWritten?.();
    return { current_revision };
  }));
  app.get("/api/mcp/revisions", guarded(async (request) => ({ revisions: await service.listRevisions(request.query) })));
  app.post("/api/mcp/revisions/:revision_id/rollback", guarded(async (request) => {
    const { write } = bodyAndWrite(request.body);
    const revisionId = integer(params(request).revision_id, "revision_id", true);
    const { current_revision } = await service.rollback(revisionId, write);
    options.onConfigWritten?.();
    return { current_revision };
  }));
}

function integer(value: unknown, label: string, fromQuery: boolean): number | undefined {
  if (value === undefined) return undefined;
  const number = fromQuery && typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
    throw invalidInput(`${label} must be a non-negative integer`);
  }
  return number;
}

function bodyAndWrite(value: unknown) {
  if (value !== undefined && !isRecord(value)) throw invalidInput("body must be an object");
  const { expected_revision, expected_version, ...body } = value ?? {};
  const expectedRevision = integer(expected_revision, "expected_revision", false);
  const expectedVersion = integer(expected_version, "expected_version", false);
  return { body, write: { ...(expectedRevision === undefined ? {} : { expectedRevision }), ...(expectedVersion === undefined ? {} : { expectedVersion }) } };
}

function queryWrite(value: unknown) {
  const query = isRecord(value) ? value : {};
  const expectedRevision = integer(query.expected_revision, "expected_revision", true);
  const expectedVersion = integer(query.expected_version, "expected_version", true);
  return { ...(expectedRevision === undefined ? {} : { expectedRevision }), ...(expectedVersion === undefined ? {} : { expectedVersion }) };
}
