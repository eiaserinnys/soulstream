import { executeMcpTool } from "../../src/mcp/tool_executor.js";
import type { McpHostOptions } from "../../src/mcp/types.js";
type McpRequestContext = { callerSessionId?: string; principal?: { authority: string; source: string; displayName: string } };
import { mcpToolDefinitions } from "@soulstream/mcp-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClusterRoundtripFixture, policy } from "../../../soul-server-ts/tests/mcp/cluster-roundtrip-fixture.js";
import { maskCluster, serialize } from "../../../soul-server-ts/tests/mcp/cluster-parity-comparator.js";

const clusterToolNames = [
  "list_recurring_jobs", "get_recurring_job", "preview_recurring_schedule", "create_recurring_job",
  "update_recurring_job", "run_recurring_job", "archive_recurring_job", "list_recurring_job_runs",
  "get_card_orchestration_settings", "update_card_orchestration_settings",
  "list_nodes", "list_node_agents", "list_node_model_presets", "reflect_cluster_brief",
  "plan_remote_agent_profile_update", "apply_remote_agent_profile_update",
  "list_remote_agents_config_snapshots", "rollback_remote_agents_config", "create_remote_agent_session",
] as const;

const context: McpRequestContext = { callerSessionId: "caller" };
const external: McpRequestContext = { callerSessionId: "forged", principal: { authority: "external", source: "llm", displayName: "External" } };
const create = { name: "새 작업", prompt: "수행", timezone: "Asia/Seoul", schedule_expressions: ["0 9 * * *"], idempotency_key: "create-key", node_id: "node-a", agent_id: "roselin", model_preset: null, folder_id: "allowed-folder" };
const profile = { id: "roselin", name: "로젤린", backend: "codex", workspace_dir: "/test/worker", aliases: ["별칭"] };
const remote = { node_id: "node-a", agent_id: "roselin", model_preset: "sol", prompt: "수행" };
type Case = readonly [label: string, name: string, args: Record<string, unknown>, context?: McpRequestContext, fails?: boolean, offline?: boolean];
const cases: Case[] = [["recurring external query", "list_recurring_jobs", {}, external, true],
["recurring external mutation", "create_recurring_job", create, external, true],
["settings external", "get_card_orchestration_settings", {}, external, true],
["external node query", "list_nodes", {}, external],
["remote external", "create_remote_agent_session", { ...remote, caller_session_id: "forged" }, external]];
describe("cluster MCP roundtrip", () => {
  let fixture: Awaited<ReturnType<typeof createClusterRoundtripFixture>>;
  beforeAll(async () => { fixture = await createClusterRoundtripFixture(); });
  afterAll(async () => { await fixture?.app.close(); fixture?.registry.disconnectNode("node-a", "test complete"); });
  async function call(name: string, args: Record<string, unknown>, requestContext: McpRequestContext, runtime = fixture.runtime){ const value = await executeMcpTool(fixture.executionOptions as unknown as McpHostOptions, name as never, args, { principal: "external", callerSessionId: null, nodeId: "worker-node", callerInfo: { source: "llm", agent_node: "worker-node", display_name: "External", user_id: null, avatar_url: null } }); const { content, structuredContent, isError, ...rest } = value; return { ...rest, content, ...(structuredContent === undefined ? {} : { structuredContent }), ...(isError === undefined ? {} : { isError }) }; }
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
});
