import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createMcpCentralService } from "../src/mcp_central/service.js";
import type { LivePostgresSql } from "../src/runtime/live_db_sql.js";
import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
} from "./board_yjs_postgres_harness.js";
import { base64, pngBytes } from "./mcp-central/test_images.js";

const hasPostgres = Boolean(process.env.TEST_DATABASE_URL?.trim())
  || spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
const describePostgres = hasPostgres ? describe : describe.skip;

function configOf(server: { config: Record<string, unknown> }): Record<string, unknown> {
  return server.config;
}

function stringRecord(value: unknown): Record<string, string> {
  return value as Record<string, string>;
}

describePostgres("MCP central config store (PostgreSQL)", () => {
  let harness: FullSchemaPostgresHarness;
  let service: ReturnType<typeof createMcpCentralService>;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    service = createMcpCentralService({
      resolveSql: async () => harness.sql as unknown as LivePostgresSql,
    });
  }, 120_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  beforeEach(async () => {
    await harness.sql`DELETE FROM mcp_agent_bindings`;
    await harness.sql`DELETE FROM mcp_config_revisions`;
    await harness.sql`DELETE FROM mcp_server_icons`;
    await harness.sql`DELETE FROM mcp_servers`;
    await harness.sql`DELETE FROM mcp_profiles`;
    await harness.sql`DELETE FROM mcp_secrets`;
    await harness.sql`DELETE FROM mcp_managed_nodes`;
    await harness.sql`DELETE FROM mcp_config_state`;
  });

  it("moves fixed header, query and env values into mcp_secrets and keeps only references", async () => {
    await service.addManagedNode("node-a");
    await service.putServer("srv-1", {
      name: "srv-one",
      type: "streamable_http",
      config: {
        url: "https://example.com/mcp?api_key=fake-secret-query&mode=fast",
        headers: { Authorization: "Bearer fake-secret-header" },
      },
      node_scope: ["node-a"],
    });
    await service.putProfile("profile-1", {
      name: "Profile One",
      mcp_servers: ["srv-1"],
      hosted_tools: [{
        type: "hosted_mcp",
        server_label: "remote",
        server_url: "https://example.com/mcp",
        authorization: "Bearer fake-secret-profile-auth",
      }],
    });

    const config = await service.getConfig();
    const server = config.servers.find((item) => item.id === "srv-1");
    expect(server).toBeDefined();
    expect(stringRecord(configOf(server!).headers).Authorization)
      .toBe("{{secret:srv-srv-1-hdr-Authorization}}");
    expect(configOf(server!).url).toBe(
      "https://example.com/mcp?api_key=%7B%7Bsecret%3Asrv-srv-1-qry-api_key%7D%7D"
        + "&mode=%7B%7Bsecret%3Asrv-srv-1-qry-mode%7D%7D",
    );
    const profile = config.profiles.find((item) => item.id === "profile-1");
    const hostedTool = profile!.hosted_tools[0] as Record<string, unknown>;
    expect(hostedTool.authorization).toBe("{{secret:prof-profile-1-ht0-auth}}");
    expect(config.secrets.map((secret) => secret.name).sort()).toEqual([
      "prof-profile-1-ht0-auth",
      "srv-srv-1-hdr-Authorization",
      "srv-srv-1-qry-api_key",
      "srv-srv-1-qry-mode",
    ]);
    expect(config.secrets.find((secret) => secret.name === "srv-srv-1-hdr-Authorization")?.servers)
      .toEqual(["srv-1"]);

    const secretRows = await harness.sql<{ name: string; value: string }[]>`
      SELECT name, value FROM mcp_secrets ORDER BY name
    `;
    expect(secretRows.map((row) => row.value).sort()).toEqual([
      "Bearer fake-secret-header",
      "Bearer fake-secret-profile-auth",
      "fake-secret-query",
      "fast",
    ]);

    const serverRows = await harness.sql`SELECT config, node_overrides FROM mcp_servers`;
    const revisionRows = await harness.sql`SELECT snapshot FROM mcp_config_revisions`;
    const profileRows = await harness.sql`SELECT mcp_servers, hosted_tools FROM mcp_profiles`;
    for (const serialized of [
      JSON.stringify(serverRows),
      JSON.stringify(revisionRows),
      JSON.stringify(profileRows),
      JSON.stringify(config),
    ]) {
      expect(serialized).not.toContain("fake-secret");
    }

    const revisionBefore = (await service.getConfig()).current_revision;
    await service.putServer("srv-stdio", {
      type: "stdio",
      config: {
        command: "run-mcp",
        env: { PLAIN: "fake-secret-env", KEEP: "{{env:HOME}}" },
      },
      node_scope: ["node-a"],
    });
    const after = await service.getConfig();
    expect(after.current_revision).toBe(revisionBefore + 1);
    expect(stringRecord(configOf(after.servers.find((item) => item.id === "srv-stdio")!).env))
      .toEqual({
        PLAIN: "{{secret:srv-srv-stdio-env-PLAIN}}",
        KEEP: "{{env:HOME}}",
      });
    expect(JSON.stringify(await service.getConfig())).not.toContain("fake-secret");
  });

  it("rejects a stale expectedRevision with 409 and leaves revision and rows untouched", async () => {
    await service.addManagedNode("node-a");
    await service.putServer("srv-1", {
      type: "streamable_http",
      config: { url: "https://example.com/mcp" },
      node_scope: ["node-a"],
    });
    const before = await service.getConfig();

    await expect(service.putServer("srv-2", {
      type: "streamable_http",
      config: { url: "https://example.com/other" },
      node_scope: ["node-a"],
    }, { expectedRevision: before.current_revision + 99 })).rejects.toMatchObject({
      code: "MCP_REVISION_CONFLICT",
      statusCode: 409,
    });

    const after = await service.getConfig();
    expect(after.current_revision).toBe(before.current_revision);
    expect(after.servers.some((server) => server.id === "srv-2")).toBe(false);
  });

  it("keeps uploads out of the revision, binds them on save, and cleans up stale and deleted rows", async () => {
    await service.addManagedNode("node-a");
    const revisionBeforeUpload = (await service.getConfig()).current_revision;
    const uploadA = await service.uploadServerIcon({
      data_base64: base64(pngBytes(16, 16)),
    });
    const uploadB = await service.uploadServerIcon({
      data_base64: base64(pngBytes(16, 16)),
    });
    expect((await service.getConfig()).current_revision).toBe(revisionBeforeUpload);

    await service.putServer("srv-icon", {
      type: "streamable_http",
      config: { url: "https://example.com/mcp" },
      node_scope: ["node-a"],
      icon: { kind: "upload", ref: uploadA.ref, content_hash: uploadA.content_hash },
    });
    const bound = await service.getConfig();
    expect(bound.servers.find((server) => server.id === "srv-icon")?.icon).toMatchObject({
      kind: "upload",
      ref: uploadA.ref,
      content_hash: uploadA.content_hash,
      url: `/api/mcp/server-icons/${uploadA.ref}?v=${uploadA.content_hash}`,
    });
    const boundRows = await harness.sql<{ server_id: string | null }[]>`
      SELECT server_id FROM mcp_server_icons WHERE id = ${uploadA.ref}::uuid
    `;
    expect(boundRows[0]?.server_id).toBe("srv-icon");

    await service.putServer("srv-icon", {
      type: "streamable_http",
      config: { url: "https://example.com/mcp" },
      node_scope: ["node-a"],
      icon: { kind: "symbol", name: "layers", color: "node-user" },
    });
    const replacedRows = await harness.sql`
      SELECT id FROM mcp_server_icons WHERE id = ${uploadA.ref}::uuid
    `;
    expect(replacedRows).toHaveLength(0);

    await harness.sql`
      UPDATE mcp_server_icons SET created_at = NOW() - INTERVAL '25 hours'
      WHERE id = ${uploadB.ref}::uuid
    `;
    const uploadC = await service.uploadServerIcon({ data_base64: base64(pngBytes(8, 8)) });
    const staleRows = await harness.sql`
      SELECT id FROM mcp_server_icons WHERE id = ${uploadB.ref}::uuid
    `;
    expect(staleRows).toHaveLength(0);
    const freshRows = await harness.sql`
      SELECT id FROM mcp_server_icons WHERE id = ${uploadC.ref}::uuid
    `;
    expect(freshRows).toHaveLength(1);

    const owned = await service.uploadServerIcon({ data_base64: base64(pngBytes(4, 4)) });
    await service.putServer("srv-icon-delete", {
      type: "streamable_http",
      config: { url: "https://example.com/mcp" },
      node_scope: ["node-a"],
      icon: { kind: "upload", ref: owned.ref, content_hash: owned.content_hash },
    });
    await service.deleteServer("srv-icon-delete");
    const deletedRows = await harness.sql`
      SELECT id FROM mcp_server_icons WHERE id = ${owned.ref}::uuid
    `;
    expect(deletedRows).toHaveLength(0);
  });

  it("refuses to delete a server, profile or secret that is still referenced", async () => {
    await service.addManagedNode("node-a");
    await service.putServer("srv-1", {
      type: "streamable_http",
      config: {
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer fake-secret-inuse" },
      },
      node_scope: ["node-a"],
    });
    await service.putProfile("profile-1", {
      name: "Profile One",
      mcp_servers: ["srv-1"],
      hosted_tools: [],
    });

    await expect(service.deleteServer("srv-1")).rejects.toMatchObject({
      code: "MCP_SERVER_INUSE",
      statusCode: 409,
    });

    await service.setAgentBindings("agent-1", {
      node_ids: ["node-a"],
      mcp_profile_id: "profile-1",
    });
    await expect(service.deleteProfile("profile-1")).rejects.toMatchObject({
      code: "MCP_PROFILE_INUSE",
      statusCode: 409,
    });

    const secret = (await service.getConfig()).secrets.find(
      (item) => item.servers.includes("srv-1"),
    );
    expect(secret).toBeDefined();
    await expect(service.deleteSecret(secret!.name)).rejects.toMatchObject({
      code: "MCP_SECRET_INUSE",
      statusCode: 409,
    });
  });

  it("rolls a server back to an earlier definition and rejects broken references", async () => {
    await service.addManagedNode("node-a");
    await service.putServer("srv-r", {
      type: "streamable_http",
      config: { url: "https://example.com/v1" },
      node_scope: ["node-a"],
    });
    const firstRevision = (await service.listRevisions({
      target: "server",
      target_id: "srv-r",
    }))[0];
    expect(firstRevision).toBeDefined();

    await service.putServer("srv-r", {
      type: "streamable_http",
      config: { url: "https://example.com/v2" },
      node_scope: ["node-a"],
    });
    const revisionBefore = (await service.getConfig()).current_revision;
    await service.rollback(firstRevision!.id);

    const restored = await service.getConfig();
    expect(restored.servers.find((server) => server.id === "srv-r")?.config)
      .toEqual({ url: "https://example.com/v1" });
    expect(restored.current_revision).toBe(revisionBefore + 1);

    await service.putServer("srv-broken", {
      type: "streamable_http",
      config: {
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer {{secret:missing-secret}}" },
      },
      node_scope: ["node-a"],
    });
    const brokenRevision = (await service.listRevisions({
      target: "server",
      target_id: "srv-broken",
    }))[0];
    const beforeBroken = (await service.getConfig()).current_revision;
    await expect(service.rollback(brokenRevision!.id)).rejects.toMatchObject({
      code: "MCP_ROLLBACK_BROKEN_REFERENCE",
      statusCode: 409,
    });
    expect((await service.getConfig()).current_revision).toBe(beforeBroken);
  });

  it("deletes the current upload when rolling back to a symbol icon", async () => {
    await service.addManagedNode("node-a");
    await service.putServer("srv-icon-rb", {
      type: "streamable_http",
      config: { url: "https://example.com/mcp" },
      node_scope: ["node-a"],
      icon: { kind: "symbol", name: "layers", color: "node-user" },
    });
    const symbolRevision = (await service.listRevisions({
      target: "server",
      target_id: "srv-icon-rb",
    }))[0];

    const upload = await service.uploadServerIcon({ data_base64: base64(pngBytes(16, 16)) });
    await service.putServer("srv-icon-rb", {
      type: "streamable_http",
      config: { url: "https://example.com/mcp" },
      node_scope: ["node-a"],
      icon: { kind: "upload", ref: upload.ref, content_hash: upload.content_hash },
    });
    await service.rollback(symbolRevision!.id);

    const rows = await harness.sql`
      SELECT id FROM mcp_server_icons WHERE id = ${upload.ref}::uuid
    `;
    expect(rows).toHaveLength(0);
    expect((await service.getConfig()).servers.find((server) => server.id === "srv-icon-rb")?.icon)
      .toEqual({ kind: "symbol", name: "layers", color: "node-user" });
  });

  it("binds agents per node, extends the profile scope and forks a profile for one node set", async () => {
    await service.addManagedNode("node-a");
    await service.addManagedNode("node-b");
    await service.putProfile("p1", { name: "P1", mcp_servers: [], hosted_tools: [] });

    await service.setAgentBindings("agent-1", {
      node_ids: ["node-a", "node-b"],
      mcp_profile_id: "p1",
    });
    let config = await service.getConfig();
    expect(config.bindings.filter((binding) => binding.agent_id === "agent-1")).toHaveLength(2);
    expect(config.profiles.find((profile) => profile.id === "p1")?.node_scope)
      .toEqual(["node-a", "node-b"]);

    await service.setAgentBindings("agent-1", {
      node_ids: ["node-a"],
      mcp_profile_id: null,
    });
    config = await service.getConfig();
    expect(config.bindings.filter((binding) => binding.agent_id === "agent-1"))
      .toEqual([expect.objectContaining({ node_id: "node-b", mcp_profile_id: "p1" })]);

    await service.putProfile("p2", {
      name: "P2",
      description: "fork source",
      mcp_servers: [],
      hosted_tools: [{ type: "web_search" }],
    });
    await service.setAgentBindings("agent-2", {
      node_ids: ["node-a"],
      mcp_profile_id: "p2",
      fork: true,
    });
    config = await service.getConfig();
    const clone = config.profiles.find((profile) => profile.id === "p2-agent-2");
    expect(clone).toMatchObject({
      name: "P2",
      description: "fork source",
      mcp_servers: [],
      hosted_tools: [{ type: "web_search" }],
      node_scope: ["node-a"],
    });
    expect(config.bindings.find(
      (binding) => binding.agent_id === "agent-2" && binding.node_id === "node-a",
    )?.mcp_profile_id).toBe("p2-agent-2");
    expect(config.bindings.find(
      (binding) => binding.agent_id === "agent-1" && binding.node_id === "node-b",
    )?.mcp_profile_id).toBe("p1");
  });
  it("removes an inactive node and its associations in one revision", async () => {
    const added = await service.addManagedNode("node-a");
    const state = await harness.sql<{ current_revision: string }[]>`SELECT current_revision FROM mcp_config_state WHERE id = 1`;
    expect(added.current_revision).toBe(Number(state[0]!.current_revision));
    await service.addManagedNode("node-b");
    await service.putServer("s", { type: "stdio", config: { command: "run", env: { TOKEN: "fake-secret-token" } }, node_scope: ["node-a", "node-b"], node_overrides: { "node-a": { type: "stdio", config: { command: "other" } } } });
    await service.putProfile("p", { name: "P", mcp_servers: ["s"], hosted_tools: [] });
    await service.setAgentBindings("agent", { node_ids: ["node-a", "node-b"], mcp_profile_id: "p" });
    const before = await service.getConfig();
    const result = await service.removeManagedNode("node-a", { expectedRevision: before.current_revision });
    const after = await service.getConfig();
    expect(result.current_revision).toBe(before.current_revision + 1);
    expect(result.current_revision).toBe(after.current_revision);
    expect(after.managed_nodes.map(node => node.node_id)).toEqual(["node-b"]);
    expect(after.bindings.map(binding => binding.node_id)).toEqual(["node-b"]);
    expect(after.servers[0]).toMatchObject({ id: "s", node_scope: ["node-b"], node_overrides: {} });
    expect(after.profiles[0]).toMatchObject({ id: "p", node_scope: ["node-b"] });
    expect(after.secrets).toHaveLength(1);
    const revisions = await service.listRevisions();
    expect(revisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: "server", target_id: "s", snapshot: expect.objectContaining({ node_scope: ["node-b"] }) }),
      expect.objectContaining({ target: "profile", target_id: "p", snapshot: expect.objectContaining({ node_scope: ["node-b"] }) }),
      expect.objectContaining({ target: "binding", snapshot: expect.objectContaining({ agent_id: "agent", node_id: "node-a", deleted: true }) }),
    ]));
  });

  it("refuses removal of activated nodes without changing configuration", async () => {
    await service.addManagedNode("node-a");
    await harness.sql`UPDATE mcp_managed_nodes SET activated_at = NOW() WHERE node_id = ${"node-a"}`;
    const before = await service.getConfig();
    const history = await service.listRevisions();
    await expect(service.removeManagedNode("node-a")).rejects.toMatchObject({ code: "MCP_NODE_ACTIVATED", statusCode: 409 });
    expect(await service.getConfig()).toEqual(before);
    expect(await service.listRevisions()).toEqual(history);
    await expect(service.removeManagedNode("missing")).rejects.toMatchObject({ code: "MCP_NODE_NOT_FOUND", statusCode: 404 });
  });

});
