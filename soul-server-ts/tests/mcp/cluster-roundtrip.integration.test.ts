import { mcpToolDefinitions } from "@soulstream/mcp-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { withMcpRequestContext, type McpRequestContext } from "../../src/mcp/request_context.js";
import { registerRecurringJobTools } from "../../src/mcp/tools/recurring_jobs.js";
import { registerCardOrchestrationTools } from "../../src/mcp/tools/card_orchestration.js";
import { registerMultiNodeTools } from "../../src/mcp/tools/multi_node.js";
import { createClusterRoundtripFixture, policy } from "./cluster-roundtrip-fixture.js";
import { maskCluster, serialize } from "./cluster-parity-comparator.js";

const clusterToolNames = [
  "list_recurring_jobs", "get_recurring_job", "preview_recurring_schedule", "create_recurring_job",
  "update_recurring_job", "run_recurring_job", "archive_recurring_job", "list_recurring_job_runs",
  "get_card_orchestration_settings", "update_card_orchestration_settings",
  "list_nodes", "list_node_agents", "list_node_model_presets", "reflect_cluster_brief",
  "plan_remote_agent_profile_update", "apply_remote_agent_profile_update",
  "list_remote_agents_config_snapshots", "rollback_remote_agents_config", "create_remote_agent_session",
] as const;

describe("cluster MCP contract availability", () => {
  it.each(clusterToolNames)("makes %s executable through the common contract", name => {
    expect(mcpToolDefinitions.find(tool => tool.name === name)).toBeDefined();
  });
});

const context: McpRequestContext = { callerSessionId: "caller" };
const external: McpRequestContext = { callerSessionId: "forged", principal: { authority: "external", source: "llm", displayName: "External" } };
const create = { name: "새 작업", prompt: "수행", timezone: "Asia/Seoul", schedule_expressions: ["0 9 * * *"], idempotency_key: "create-key", node_id: "node-a", agent_id: "roselin", model_preset: null, folder_id: "allowed-folder" };
const profile = { id: "roselin", name: "로젤린", backend: "codex", workspace_dir: "/test/worker", aliases: ["별칭"] };
const remote = { node_id: "node-a", agent_id: "roselin", model_preset: "sol", prompt: "수행" };
type Case = readonly [label: string, name: string, args: Record<string, unknown>, context?: McpRequestContext, fails?: boolean, offline?: boolean];
const cases: Case[] = [
  ["list recurring", "list_recurring_jobs", {}],
  ["get recurring", "get_recurring_job", { job_id: "job-1" }],
  ["preview cron", "preview_recurring_schedule", { timezone: "Asia/Seoul", schedule_expressions: ["0 9 * * *"] }],
  ["create cron", "create_recurring_job", create],
  ["create once", "create_recurring_job", { ...create, schedule_expressions: undefined, run_at: "2099-10-01T09:00:00+09:00" }],
  ["update recurring", "update_recurring_job", { job_id: "job-1", expected_version: 1, enabled: false }],
  ["run recurring", "run_recurring_job", { job_id: "job-1", idempotency_key: "run-key" }],
  ["archive recurring", "archive_recurring_job", { job_id: "job-1", expected_version: 1 }],
  ["recurring history limit", "list_recurring_job_runs", { job_id: "job-1", limit: 1 }],
  ["recurring external query", "list_recurring_jobs", {}, external, true],
  ["recurring external mutation", "create_recurring_job", create, external, true],
  ["recurring no session", "create_recurring_job", create, {}, true],
  ["recurring no email", "list_recurring_jobs", {}, { callerSessionId: "no-email" }, true],
  ["recurring missing", "get_recurring_job", { job_id: "missing" }, context, true],
  ["recurring bad version", "update_recurring_job", { job_id: "job-1", expected_version: 999 }, context, true],
  ["recurring archive bad version", "archive_recurring_job", { job_id: "job-1", expected_version: 999 }, context, true],
  ["recurring bad cron", "preview_recurring_schedule", { timezone: "Asia/Seoul", schedule_expressions: ["invalid"] }, context, true],
  ["get settings", "get_card_orchestration_settings", {}],
  ["update settings", "update_card_orchestration_settings", { policy, expectedVersion: 1 }],
  ["settings external", "get_card_orchestration_settings", {}, external, true],
  ["settings mismatch", "get_card_orchestration_settings", { caller_session_id: "other" }, context, true],
  ["settings non-admin", "get_card_orchestration_settings", {}, { callerSessionId: "limited" }, true],
  ["settings decision", "get_card_orchestration_settings", {}, { callerSessionId: "decision" }, true],
  ["settings no session", "update_card_orchestration_settings", { policy, expectedVersion: 1 }, {}, true],
  ["settings version", "update_card_orchestration_settings", { policy, expectedVersion: 999 }, context, true],
  ["list nodes", "list_nodes", {}],
  ["list agents", "list_node_agents", { node_id: "node-a" }],
  ["list presets", "list_node_model_presets", { node_id: "node-a" }],
  ["reflect brief", "reflect_cluster_brief", {}],
  ["external node query", "list_nodes", {}, external],
  ["profile plan", "plan_remote_agent_profile_update", { node_id: "node-a", profile, create_if_missing: true, includeTextDiff: true }],
  ["profile apply", "apply_remote_agent_profile_update", { node_id: "node-a", profile, expectedConfigChecksum: "checksum", include_text_diff: true }],
  ["snapshots", "list_remote_agents_config_snapshots", { node_id: "node-a" }],
  ["rollback id", "rollback_remote_agents_config", { node_id: "node-a", snapshot_id: "snapshot", includeTextDiff: true }],
  ["rollback path", "rollback_remote_agents_config", { node_id: "node-a", snapshot_path: "/test/snapshot.yaml" }],
  ["rollback missing selector", "rollback_remote_agents_config", { node_id: "node-a" }, context, true],
  ["profile invalid", "plan_remote_agent_profile_update", { node_id: "node-a", profile: { ...profile, max_turns: 0 } }, context, true],
  ["profile missing transport", "plan_remote_agent_profile_update", { node_id: "node-a", profile }, context, true, true],
  ["remote inherited folder", "create_remote_agent_session", remote],
  ["remote explicit folder", "create_remote_agent_session", { ...remote, folder_id: "forbidden-folder" }],
  ["remote null folder", "create_remote_agent_session", { ...remote, folder_id: null }],
  ["remote no notification", "create_remote_agent_session", { ...remote, notify_completion: false }],
  ["remote card", "create_remote_agent_session", { ...remote, card_id: "card-1", reasoning_effort: "high" }],
  ["remote missing preset", "create_remote_agent_session", { ...remote, model_preset: "unknown" }, context, true],
  ["remote missing caller", "create_remote_agent_session", remote, {}, true],
  ["remote external", "create_remote_agent_session", { ...remote, caller_session_id: "forged" }, external],
  ["remote limited forbidden", "create_remote_agent_session", { ...remote, folder_id: "forbidden-folder" }, { callerSessionId: "limited" }, true],
  ["remote limited omitted", "create_remote_agent_session", remote, { callerSessionId: "limited" }],
  ["remote administrator unrestricted", "create_remote_agent_session", { ...remote, folder_id: "forbidden-folder" }],
];
for (const [name, args] of [
  ["get_recurring_job", { job_id: "missing" }], ["update_recurring_job", { job_id: "missing", expected_version: 1 }],
  ["run_recurring_job", { job_id: "missing", idempotency_key: "run" }], ["archive_recurring_job", { job_id: "missing", expected_version: 1 }],
  ["list_recurring_job_runs", { job_id: "missing" }],
  ["list_node_agents", { node_id: "missing" }], ["list_node_model_presets", { node_id: "missing" }],
  ["plan_remote_agent_profile_update", { node_id: "missing", profile }], ["apply_remote_agent_profile_update", { node_id: "missing", profile }],
  ["list_remote_agents_config_snapshots", { node_id: "missing" }], ["rollback_remote_agents_config", { node_id: "missing", snapshot_id: "snapshot" }],
  ["create_remote_agent_session", { ...remote, node_id: "missing" }],
] as const) cases.push([`${name} absent resource`, name, args, context, true]);

describe("cluster MCP roundtrip", () => {
  let fixture: Awaited<ReturnType<typeof createClusterRoundtripFixture>>;
  beforeAll(async () => { fixture = await createClusterRoundtripFixture(); });
  afterAll(async () => { await fixture?.app.close(); fixture?.registry.disconnectNode("node-a", "test complete"); });
  async function call(name: string, args: Record<string, unknown>, requestContext: McpRequestContext, runtime = fixture.runtime) {
    const server = new McpServer({ name: "cluster-parity", version: "1" });
    registerRecurringJobTools(server, runtime);
    registerCardOrchestrationTools(server, runtime);
    registerMultiNodeTools(server, runtime);
    const client = new Client({ name: "parity-client", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(st); await client.connect(ct);
      return await withMcpRequestContext(requestContext, () => client.callTool({ name, arguments: args }));
    } finally { await client.close(); await server.close(); }
  }
  it.each(cases)("preserves %s", async (label, name, args, requestContext = context, fails = false, offline = false) => {
    fixture.seed(offline);
    const next = await call(name, args, requestContext);
    expect(next.isError === true, JSON.stringify(next)).toBe(fails);
    expect(serialize(name, next)).toMatchSnapshot("result");
    expect(JSON.stringify(fixture.sent.map(cmd => maskCluster("create_remote_agent_session", cmd)))).toMatchSnapshot("node commands");
    expect(JSON.stringify(fixture.recurring.validateTarget.mock.calls)).toMatchSnapshot("recurring actors");
    if (name === "list_recurring_job_runs" && !fails) expect((next.structuredContent as any).runs).toHaveLength(1);
    if (label === "remote limited omitted") expect(fixture.sent[0]).toHaveProperty("folderId", "allowed-folder");
    if (label === "remote inherited folder") expect(fixture.sent[0]).toHaveProperty("folderId", "inherited-folder");
    if (label === "remote no notification") expect(fixture.sent[0]).toMatchObject({ caller_session_id: "caller", notify_completion: false });
    if (label === "remote external") expect(fixture.sent[0]).not.toHaveProperty("caller_session_id");
  });
  it.each([
    ["list_nodes", {}, context], ["create_remote_agent_session", remote, {}],
    ["list_recurring_jobs", {}, context], ["list_recurring_jobs", {}, {}],
    ["list_recurring_jobs", {}, external], ["list_recurring_jobs", {}, { callerSessionId: "no-email" }],
    ["get_card_orchestration_settings", {}, context], ["get_card_orchestration_settings", {}, {}],
    ["get_card_orchestration_settings", { caller_session_id: "other" }, context],
    ["get_card_orchestration_settings", {}, external],
  ] as const)("preserves unavailable transport for %s %j %j", async (name, args, requestContext) => {
    const runtime = { ...fixture.runtime, orch: undefined };
    expect(serialize(name, await call(name, args, requestContext, runtime))).toMatchSnapshot("result");
  });
});

describe("cluster snapshot masking", () => {
  it("masks only the generated session id and time", () => {
    expect(maskCluster("create_remote_agent_session", { agentSessionId: "first", updatedAt: "old", id: "seed" }))
      .toEqual({ agentSessionId: "<session-id>", updatedAt: "<time>", id: "seed" });
    expect(maskCluster("list_nodes", { agentSessionId: "first", updatedAt: null }))
      .toEqual({ agentSessionId: "first", updatedAt: null });
  });
});
