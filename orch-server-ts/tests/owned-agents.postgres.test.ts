import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { SqlOwnedAgentRepository } from "../src/owned-agents/repository.js";
import { OwnedAgentService, agentTokenHash } from "../src/owned-agents/service.js";
import { registerOwnedAgentRoutes } from "../src/owned-agents/routes.js";
import { createSessionOwnerResolver } from "../src/session/session_owner.js";
import { executeMcpTool } from "../src/mcp/tool_executor.js";
import { registerExternalEventsRoutes } from "../src/mcp/external_events_transport.js";
import { registerMcpHostRoutes } from "../src/mcp/mcp_host_routes.js";
import type { McpHostOptions } from "../src/mcp/types.js";
import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from "@modelcontextprotocol/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { recurringJobTools } from "@soulstream/mcp-contract";
import { RecurringJobService } from "../src/recurring-jobs/service.js";
import { SqlRecurringJobRepository } from "../src/recurring-jobs/repository.js";
import { createRecurringJobTargetValidator } from "../src/recurring-jobs/target_validator.js";
import { InMemoryNodeRegistry } from "../src/node/registry.js";

describe("central owned agents through REST and real MCP HTTP", () => {
  let h: PagePostgresHarness, repository: SqlOwnedAgentRepository, service: OwnedAgentService;
  const owner = "owner@example.test", other = "other@example.test";
  const users = async (email: string) => [owner, other].includes(email) ? { email, isAdmin: email === owner, allowedFolderIds: [] } : null;
  beforeAll(async () => {
    // Existing harness always creates a fresh, isolated schema in its test-only container.
    h = await createPagePostgresHarness();
    await h.sql`CREATE TABLE users(email TEXT PRIMARY KEY)`;
    expect(Number((await h.sql`SELECT COUNT(*) FROM users`)[0]!.count)).toBe(0);
    await h.sql`INSERT INTO users(email) VALUES(${owner}),(${other})`;
    await h.sql.unsafe(await readFile(new URL("../../packages/db-schema/sql/migrations/117_owned_external_agents.sql", import.meta.url), "utf8"));
    repository = new SqlOwnedAgentRepository({ resolveSql: async () => h.liveSql, close: async () => {} });
    service = new OwnedAgentService(repository, users, "configured-test-credential");
  }, 60000);
  afterAll(async () => h?.cleanup());

  it("applies migration, stores only a verifier, authorizes owner/admin and never resurrects revoked env credentials", async () => {
    const app = Fastify();
    registerOwnedAgentRoutes(app, { service, currentEmail: req => req.headers["test-user"] as string | undefined });
    const request = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, email = owner, payload?: Record<string, unknown>) =>
      app.inject({ method, url, headers: email ? { "test-user": email } : {}, ...(payload === undefined ? {} : { payload }) });
    try {
      expect((await request("GET", "/api/owned-agents", "")).statusCode).toBe(401);
      expect((await request("POST", "/api/owned-agents/register-existing", other, {})).statusCode).toBe(403);
      expect((await request("POST", "/api/owned-agents", owner, { name: "spoof", ownerEmail: other })).statusCode).toBe(422);
      const created = await request("POST", "/api/owned-agents", owner, { name: "Owned" });
      expect(created.statusCode).toBe(201); const id = created.json().agent.id;
      expect((await request("PATCH", `/api/owned-agents/${id}`, other, { enabled: false })).statusCode).toBe(404);
      const issued = await request("POST", `/api/owned-agents/${id}/keys`, owner, {});
      expect(issued.statusCode).toBe(201); const { token, credential } = issued.json();
      expect(Buffer.from(token.slice("ss_agent_".length), "base64url").length).toBeGreaterThanOrEqual(32);
      const stored = (await h.sql`SELECT token_hash FROM external_agent_credentials WHERE id=${credential.id}`)[0]!;
      expect(stored.token_hash === agentTokenHash(token)).toBe(true);
      expect(stored.token_hash === token).toBe(false);
      expect(await service.authenticate(token)).toMatchObject({ agentId: id, ownerEmail: owner });
      const list = await request("GET", "/api/owned-agents");
      expect(list.body.includes(token)).toBe(false); expect(list.body.includes(String(stored.token_hash))).toBe(false);
      expect(list.json().agents.find((a: any) => a.id === id).keys[0].lastUsedAt).toBeTruthy();
      expect((await request("PATCH", `/api/owned-agents/${id}`, owner, { enabled: false })).statusCode).toBe(200);
      await expect(service.authenticate(token)).rejects.toMatchObject({ statusCode: 401 });
      expect((await request("DELETE", `/api/owned-agents/${id}/keys/${credential.id}`)).statusCode).toBe(204);
      await expect(service.authenticate(token)).rejects.toMatchObject({ statusCode: 401 });
      expect(await service.authenticate("configured-test-credential")).toBeNull();
      const existing = await request("POST", "/api/owned-agents/register-existing", owner, { name: "Dot" });
      expect(existing.statusCode).toBe(200); const registered = existing.json();
      expect((await request("POST", "/api/owned-agents/register-existing", owner, {})).json()).toEqual(registered);
      await expect(new OwnedAgentService(repository, async email => ({ email, isAdmin: true, allowedFolderIds: [] }), "configured-test-credential").registerExisting(other)).rejects.toMatchObject({ statusCode: 409 });
      expect(await service.authenticate("configured-test-credential")).toMatchObject({ agentId: registered.agent.id });
      await service.revoke(owner, registered.agent.id, registered.credential.id);
      await expect(service.authenticate("configured-test-credential")).rejects.toMatchObject({ statusCode: 401 });
      await expect(service.registerExisting(owner)).rejects.toMatchObject({ statusCode: 409 });
      expect((await request("POST", "/api/owned-agents/register-existing", owner, {})).statusCode).toBe(409);
      const failingList = vi.spyOn(repository, "list").mockRejectedValueOnce(new Error("private database detail"));
      const unavailableList = await request("GET", "/api/owned-agents");
      expect(unavailableList.statusCode).toBe(503); expect(unavailableList.body.includes("private database detail")).toBe(false); failingList.mockRestore();
      await expect(new OwnedAgentService({ ...repository, credential: async () => { throw new Error("DB offline"); } } as any, users, "configured-test-credential").authenticate("configured-test-credential")).rejects.toMatchObject({ statusCode: 503 });
    } finally { await app.close(); }
  });

  it.each(["modern", "legacy"] as const)("%s exposes exactly eight owned scheduling tools, isolates request identities and rejects caller injection", async era => {
    const agent = await service.create(owner, "HTTP"); const issued = await service.issue(owner, agent.id);
    const second = await service.create(other, "Second"); const secondKey = await service.issue(other, second.id);
    const legacyService = new OwnedAgentService(repository, users, "unregistered-legacy");
    const actors: any[] = [];
    const list = vi.fn(async actor => { actors.push(actor); return []; });
    const options = { recurringJobs: { service: { list } } } as unknown as McpHostOptions;
    const app = Fastify(); const close = registerExternalEventsRoutes(app, options, {
      path: "/dot", nodeId: "node", source: "dot", displayName: "Dot", ownedAgents: legacyService,
      auth: { requireAuth: true, bearerToken: "unregistered-legacy", allowedHosts: [] },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const clients: (Client | ModernClient)[] = [];
    async function connect(token: string) {
      const client = era === "modern" ? new ModernClient({ name: "owned", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } }) : new Client({ name: "owned", version: "1" });
      const url = new URL(`http://127.0.0.1:${(app.server.address() as any).port}/dot`);
      const config = { requestInit: { headers: { authorization: `Bearer ${token}`, "x-soulstream-agent-session-id": "forged" } } };
      await client.connect(era === "modern" ? new ModernTransport(url, config) : new StreamableHTTPClientTransport(url, config));
      clients.push(client); return client;
    }
    try {
      const legacy = await connect("unregistered-legacy"), owned = await connect(issued.token), peer = await connect(secondKey.token);
      expect((await legacy.listTools()).tools).toHaveLength(64);
      const tools = (await owned.listTools()).tools;
      expect(tools).toHaveLength(72);
      expect(tools.filter(t => t.name in recurringJobTools).map(t => t.name).sort()).toEqual(Object.keys(recurringJobTools).sort());
      expect(tools.some(t => t.name === "send_to_external_llm" || t.name === "register_existing_mcp_agent")).toBe(false);
      expect(tools.find(t => t.name === "list_recurring_jobs")!.inputSchema.properties).not.toHaveProperty("caller_session_id");
      await Promise.all([owned.callTool({ name: "list_recurring_jobs", arguments: { caller_session_id: "forged", owner_email: other } }),
        peer.callTool({ name: "list_recurring_jobs", arguments: {} })]);
      expect(actors.map(a => a.ownerEmail).sort()).toEqual([owner, other].sort());
      expect(actors.find(a => a.ownerEmail === owner)).toMatchObject({ actorId: agent.id, source: "external-llm",
        callerInfo: { source: "dot", email: owner, external_agent_id: agent.id } });
      expect(await legacy.callTool({ name: "list_recurring_jobs", arguments: {} })).toMatchObject({ isError: true });
      await service.revoke(owner, agent.id, issued.credential.id);
      await expect(owned.listTools()).rejects.toBeTruthy();
      const fail = vi.spyOn(repository, "credential").mockRejectedValueOnce(new Error("offline"));
      const unavailable = await app.inject({ method: "POST", url: "/dot", headers: { authorization: "Bearer unregistered-legacy" }, payload: {} });
      expect(unavailable.statusCode).toBe(503); fail.mockRestore();
    } finally { for (const client of clients) await client.close().catch(() => {}); await close(); await app.close(); }
  });

  it("internal registration/recurring use durable owner instead of forwarded email or worker memory", async () => {
    const resolve = createSessionOwnerResolver({ getSession: async id => id === "stored" ? { metadata: [{ type: "caller_info", value: { source: "browser", email: owner } }] } : id === "child" ? { caller_session_id: "stored" } : null,
      findUserByEmail: users, findExternalAgent: service.findAgent });
    const ownService = new OwnedAgentService(repository, users, "internal-bootstrap");
    const list = vi.fn(async () => []);
    const options = { ownedAgents: ownService, resolveSessionOwner: resolve, authBearerToken: "internal",
      recurringJobs: { service: { list } } } as unknown as McpHostOptions;
    const app = Fastify(); registerMcpHostRoutes(app, options);
    const call = (tool: string, args: any, context: any) => app.inject({ method: "POST", url: `/api/mcp/host/${tool}`,
      headers: { authorization: "Bearer internal" }, payload: { args, context: { principal: "internal", node_id: "node", ...context } } });
    try {
      expect((await call("register_existing_mcp_agent", {}, { caller_session_id: "child", callerInfo: { email: other }, ownedAgent: { ownerEmail: other } })).json()).toMatchObject({ structuredContent: { agent: { ownerEmail: owner } } });
      expect((await call("register_existing_mcp_agent", { caller_session_id: "stored" }, { caller_session_id: "child" })).json()).toMatchObject({ isError: true });
      expect((await call("list_recurring_jobs", {}, { caller_session_id: "child", callerInfo: { email: other } })).json().isError).not.toBe(true);
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ ownerEmail: owner }), false);
      expect((await call("list_recurring_jobs", {}, { caller_session_id: "absent", callerInfo: { email: owner } })).json()).toMatchObject({ isError: true });
    } finally { await app.close(); }
  });
  it("creates and updates a real SQL reservation over HTTP MCP with existing target and owner ACL", async () => {
    for (const migration of ["094_recurring_jobs.sql", "106_recurring_jobs_once.sql"])
      await h.sql.unsafe(await readFile(new URL(`../../packages/db-schema/sql/migrations/${migration}`, import.meta.url), "utf8"));
    await h.sql`ALTER TABLE recurring_jobs DROP COLUMN container_kind, DROP COLUMN container_id`;
    const resolver = { resolveSql: async () => h.liveSql, close: async () => {} };
    const jobs = new SqlRecurringJobRepository(resolver);
    const registry = new InMemoryNodeRegistry();
    registry.registerNode({ type: "node_register", node_id: "node", agents: [{ id: "roselin", backend: "codex" }],
      model_presets: [{ id: "model", label: "Model", backend: "codex", available: true, usage_provider: null }], supported_backends: ["codex"] });
    const modelCheck = vi.fn();
    const recurring = new RecurringJobService({ repository: jobs, validateTarget: createRecurringJobTargetValidator({ registry,
      modelPresetAvailability: { requireAvailable: modelCheck }, listFolders: () => [{ id: "allowed" }, { id: "private" }],
      findUserByEmail: async email => ({ email, isAdmin: false, allowedFolderIds: ["allowed"] }),
    }) });
    const agent = await service.create(owner, "Reservation MCP"), stranger = await service.create(other, "Other MCP");
    const issued = await service.issue(owner, agent.id), foreign = await service.issue(other, stranger.id);
    const app = Fastify(); const close = registerExternalEventsRoutes(app, { recurringJobs: { service: recurring } } as unknown as McpHostOptions,
      { path: "/dot", nodeId: "node", source: "dot", displayName: "Dot", ownedAgents: service,
        auth: { requireAuth: true, bearerToken: "configured-test-credential", allowedHosts: [] } });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const clients: Client[] = [];
    async function connect(token: string) {
      const client = new Client({ name: "SQL reservation", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(app.server.address() as any).port}/dot`),
        { requestInit: { headers: { authorization: `Bearer ${token}` } } })); clients.push(client); return client;
    }
    try {
      const own = await connect(issued.token), peer = await connect(foreign.token);
      const input = { name: "Reservation", prompt: "Work", idempotency_key: "owned-create", enabled: false,
        timezone: "UTC", schedule_expressions: ["0 9 * * *"], node_id: "node", agent_id: "roselin", model_preset: "model", folder_id: "allowed" };
      const created = await own.callTool({ name: "create_recurring_job", arguments: { ...input, owner_email: other, caller_session_id: "fake" } }) as any;
      expect(created.isError).not.toBe(true); const id = created.structuredContent.job.job_id;
      expect(created.structuredContent.job.owner_email).toBe(owner); expect(modelCheck).toHaveBeenCalledWith("node", "model");
      const stored = await jobs.findJobForOwner(id, owner);
      expect(stored?.executionCaller).toMatchObject({ source: "dot", email: owner, external_agent_id: agent.id, agent_id: agent.id });
      expect(await peer.callTool({ name: "get_recurring_job", arguments: { job_id: id } })).toMatchObject({ isError: true, structuredContent: { error: expect.stringContaining("not found") } });
      expect(await peer.callTool({ name: "list_recurring_jobs", arguments: {} })).toMatchObject({ structuredContent: { jobs: [] } });
      expect(await own.callTool({ name: "update_recurring_job", arguments: { job_id: id, expected_version: 1, name: "Updated" } })).toMatchObject({ structuredContent: { job: { name: "Updated", version: 2 } } });
      expect(await own.callTool({ name: "create_recurring_job", arguments: { ...input, idempotency_key: "denied", folder_id: "private" } })).toMatchObject({ isError: true, structuredContent: { error: expect.stringContaining("access is not allowed") } });
    } finally { for (const client of clients) await client.close(); await close(); await app.close(); }
  });
});
