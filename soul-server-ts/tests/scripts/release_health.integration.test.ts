import Fastify from "fastify";
import pino from "pino";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AgentRegistry } from "../../src/agent_registry.js";
import { parseEnv } from "../../src/config.js";
import { localInternalMcpUrl } from "../../src/mcp/endpoint_paths.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { buildServer, startInternalMcpServer } from "../../src/server.js";
import { deriveInternalMcpHealthUrl, readMcpHealth, verifyReleaseHealth } from "../../scripts/verify-release-health.mjs";

// Real listeners/SDK follow stateless_restart_recovery.test.ts; only the
// orchestrator host's backing data is synthetic. No MCP client or fetch mock.
let worker: Awaited<ReturnType<typeof buildServer>>;
let host: ReturnType<typeof Fastify>;
let env: Record<string, string>;
let forwarded: Array<{ tool: string; args: unknown; context: unknown }>;

beforeEach(async () => {
  forwarded = [];
  host = Fastify();
  host.post<{ Params: { tool: string }; Body: { args: unknown; context: unknown } }>(
    "/api/mcp/host/:tool", async request => {
      expect(request.headers.authorization).toBe("Bearer health-test");
      forwarded.push({ tool: request.params.tool, ...request.body });
      const data = request.params.tool === "list_cards" ? { cards: [] }
        : { id: "health-folder", title: "Health", cards: [], view: "outline" };
      return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
    },
  );
  const hostUrl = await host.listen({ host: "127.0.0.1", port: 0 });
  const logger = pino({ level: "silent" });
  const runtime = {
    nodeId: "health-node", agentsConfigPath: "/tmp/health-agents.yaml", logger,
    db: {}, taskManager: { listTasks: () => [], getTask: () => undefined },
    taskExecutor: {}, onResume: () => undefined, agentRegistry: new AgentRegistry([]),
    catalogService: {}, orch: { baseUrl: hostUrl, headers: { authorization: "Bearer health-test" } },
  } as unknown as McpRuntime;
  worker = await buildServer({ host: "127.0.0.1", port: 0, nodeId: runtime.nodeId, logger,
    mcp: { runtime, path: "/health-mcp/",
      auth: { requireAuth: true, bearerToken: "health-test", allowedHosts: ["127.0.0.1", "localhost"] } } });
  const publicUrl = await worker.listen({ host: "127.0.0.1", port: 0 });
  const internalUrl = await startInternalMcpServer(worker.internalMcpServer!, 0);
  env = { HOST: "127.0.0.1", PORT: new URL(publicUrl).port,
    MCP_INTERNAL_PORT: new URL(internalUrl).port, MCP_PATH: "/health-mcp/",
    MCP_ENABLED: "true", AUTH_BEARER_TOKEN: "health-test" };
});

afterEach(async () => {
  await worker?.closeMcp?.();
  await worker?.internalMcpServer?.close();
  await worker?.close();
  await host?.close();
});

it.each([null, "health-folder"])("reads %s through the internal listener without a caller session", async folderId => {
  const result = await readMcpHealth({ url: new URL(localInternalMcpUrl(Number(env.MCP_INTERNAL_PORT), env.MCP_PATH)),
    token: env.AUTH_BEARER_TOKEN, folderId });
  expect(result).toEqual({ ping: "ok", tool: folderId ? "get_folder" : "list_cards", folder_id: folderId });
  expect(forwarded).toEqual([{ tool: folderId ? "get_folder" : "list_cards",
    args: folderId ? { folder_id: folderId, view: "outline" } : {},
    context: { principal: "internal", caller_session_id: null, node_id: "health-node" } }]);
});

it.each([null, "health-folder"])("release health uses the live internal listener for %s", async folderId => {
  const publicResponse = await fetch(`http://${env.HOST}:${env.PORT}/health-mcp/internal`);
  expect(publicResponse.status).toBe(404);
  const result = await verifyReleaseHealth({ scope: "standalone", folderId, env, cwd: "/tmp/health-no-env" });
  expect(result.status).toBe("ok");
  expect(result.mcp).toEqual({ ping: "ok", tool: folderId ? "get_folder" : "list_cards", folder_id: folderId });
  expect(forwarded).toHaveLength(1);
  expect(forwarded[0].context).toEqual({ principal: "internal", caller_session_id: null, node_id: "health-node" });
});

// The release script runs as plain Node JS and cannot import the bundled TS
// helper. Bind its calculation to both product port and path rules.
it.each([
  { PORT: "4205", MCP_PATH: "/mcp" },
  { PORT: "4305", MCP_PATH: "/custom-mcp/" },
  { PORT: "4405", MCP_INTERNAL_PORT: "4506", MCP_PATH: "/custom-mcp/internal" },
])("matches the worker endpoint calculation for %j", settings => {
  const input = { SOULSTREAM_NODE_ID: "health-node", SOULSTREAM_UPSTREAM_URL: "ws://localhost:5200/ws/node",
    EVENT_OUTBOX_DIR: "/tmp/health-outbox", ...settings };
  const parsed = parseEnv(input);
  expect(deriveInternalMcpHealthUrl({ HOST: "0.0.0.0", ...input }).toString()).toBe(
    localInternalMcpUrl(parsed.MCP_INTERNAL_PORT, parsed.MCP_PATH),
  );
});
