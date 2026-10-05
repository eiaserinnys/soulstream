import { describe, expect, it, vi } from "vitest";
import { recurringJobTools, type McpToolName } from "@soulstream/mcp-contract";
import { executeMcpTool } from "../src/mcp/tool_executor.js";
import type { McpCallContext, McpHostOptions } from "../src/mcp/types.js";
import { ModelPresetAvailabilityError } from "../src/model/model_preset_availability.js";

// Same executeMcpTool/provider seam as mcp-external-llm.test.ts. No DB or live node.
const callerInfo = { source: "agent", agent_node: "node-test", agent_id: "codex-default", email: "owner@example.com" };
const context: McpCallContext = { principal: "internal", callerSessionId: "caller-sess-1", nodeId: "node-test", callerInfo };
const remote = { node_id: "node-remote", agent_id: "roselin_codex", prompt: "delegate", caller_session_id: "caller-sess-1" };
const createInput = { name: "music recommendation", prompt: "recommend music", idempotency_key: "recurring:create:1", timezone: "Asia/Seoul", schedule_expressions: ["0 9,12 * * 1-5"], node_id: "node-a", agent_id: "roselin", model_preset: null, folder_id: "folder-a", enabled: false };

function fixture() {
  const prepare = vi.fn(async ({ body }: { body: Record<string, unknown> }) => ({ payload: body }));
  const createSession = vi.fn((_payload: unknown) => ({ node: { nodeId: "node-remote" } }));
  const send = vi.fn(async () => ({ type: "session_created" }));
  const profiles = {
    listAgentProfiles: vi.fn(async () => ({})),
    planAgentProfileUpdate: vi.fn(async () => ({})), applyAgentProfileUpdate: vi.fn(async () => ({})),
    listAgentsConfigSnapshots: vi.fn(async () => ({})), rollbackAgentsConfig: vi.fn(async () => ({})),
  };
  const readSession = vi.fn(async () => ({ folder_id: "caller-folder" }));
  const options = { cluster: {
    sessions: { router: { createSession }, bridge: { sendPendingCommand: send }, createSessionLifecycle: { prepare } },
    nodeAgentProfiles: { provider: profiles, modelPresetProvider: { listForNode: vi.fn(() => undefined) } },
    readSession, logger: { warn: vi.fn() },
  } } as unknown as McpHostOptions;
  const call = (name: McpToolName, args: Record<string, unknown>, c = context) => executeMcpTool(options, name, args, c);
  return { options, call, prepare, createSession, send, profiles, readSession };
}

describe("list_node_model_presets", () => {
  it("오케스트레이터의 노드별 가용성 응답을 공개 필드 그대로 반환", async () => {
    const f = fixture();
    const presets = [
      { id: "kimi-3", label: "Kimi - 3", backend: "claude", available: false, reason: "env_unresolved", reason_label: "키 미설정", resets_at: null, usage_warning: false, weekly_headroom: null },
      { id: "claude-opus", label: "Claude - Opus", backend: "claude", available: true, reason: null, reason_label: null, resets_at: null, usage_warning: true, weekly_headroom: { status: "ok", headroom: -10.5, remaining_percent: 83, window_remaining_percent: 93.5, resets_at: "2026-08-03T16:00:00.000Z", observed_at: "2026-07-28T03:00:00.000Z", quota_label: "7일" } },
    ];
    f.options.cluster.nodeAgentProfiles.modelPresetProvider = { listForNode: () => presets as never };
    expect(await f.call("list_node_model_presets", { node_id: "node-remote" })).toMatchObject({ structuredContent: { model_presets: presets } });
  });
  it("미연결 노드는 오케스트레이터 404를 MCP 오류로 반환", async () => {
    expect(await fixture().call("list_node_model_presets", { node_id: "missing-node" })).toMatchObject({ isError: true, structuredContent: { error: expect.stringContaining("Node missing-node not connected") } });
  });
});

describe("create_remote_agent_session", () => {
  it("원격 세션 요청에는 worktree와 소유권 검증 caller를 싣지 않는다", async () => {
    const f = fixture();
    expect((await f.call("create_remote_agent_session", { ...remote, worktree_id: "22222222-2222-4222-8222-222222222222" })).isError).not.toBe(true);
    const body = f.prepare.mock.calls[0]![0].body;
    expect(body).toMatchObject({ nodeId: "node-remote" });
    expect(body).not.toHaveProperty("worktree_id");
    expect(body).not.toHaveProperty("worktree_actor_session_id");
  });
  it("목록에 없는 agent_id의 판정은 alias를 아는 세션 생성 정본에 맡긴다", async () => {
    const f = fixture();
    f.createSession.mockImplementation(() => { throw new Error("agent_id를 찾을 수 없습니다: roselin"); });
    expect(await f.call("create_remote_agent_session", { ...remote, agent_id: "roselin" })).toMatchObject({ isError: true, structuredContent: { error: expect.stringContaining("agent_id를 찾을 수 없습니다: roselin") } });
    expect(f.profiles.listAgentProfiles).not.toHaveBeenCalled();
    expect(f.createSession).toHaveBeenCalledOnce();
  });
  it("프로필 목록에 광고되지 않은 alias도 세션 생성 정본에 그대로 전달한다", async () => {
    const f = fixture();
    expect((await f.call("create_remote_agent_session", remote)).isError).not.toBe(true);
    expect(f.prepare.mock.calls[0]![0].body.profile).toBe("roselin_codex");
    expect(f.profiles.listAgentProfiles).not.toHaveBeenCalled();
    expect(f.createSession).toHaveBeenCalledOnce();
  });
  it("잘못된 원격 preset 오류에 노드별 조회 도구 힌트를 제공", async () => {
    const f = fixture();
    f.createSession.mockImplementation(() => { throw new ModelPresetAvailabilityError("MODEL_PRESET_NOT_FOUND", "Model preset 'opus' is not advertised by node node-remote"); });
    expect(await f.call("create_remote_agent_session", { node_id: "node-remote", prompt: "delegate", model_preset: "opus", caller_session_id: "caller-sess-1" })).toMatchObject({ isError: true, structuredContent: { error: "Model preset 'opus' is not advertised by node node-remote. Call list_node_model_presets with node_id 'node-remote' to list valid preset ids." } });
  });
  it("agent_id가 정확히 일치하면 추가 조회 없이 세션 생성 정본에 전달한다", async () => {
    const f = fixture();
    expect((await f.call("create_remote_agent_session", { ...remote, folder_id: "folder-1", notify_completion: false, model_preset: "codex-5.6-sol" })).isError).not.toBe(true);
    expect(f.prepare.mock.calls[0]![0].body).toMatchObject({ profile: "roselin_codex", nodeId: "node-remote", folderId: "folder-1", model_preset: "codex-5.6-sol", caller_session_id: "caller-sess-1", notify_completion: false, caller_info: callerInfo });
    expect(f.profiles.listAgentProfiles).not.toHaveBeenCalled();
    expect(f.createSession).toHaveBeenCalledOnce();
  });
  it("MCP 요청 header의 caller id로 remote caller_session_id와 caller_info를 전달한다", async () => {
    const f = fixture();
    const { caller_session_id: _caller, ...args } = remote;
    expect((await f.call("create_remote_agent_session", args)).isError).not.toBe(true);
    expect(f.prepare.mock.calls[0]![0].body).toMatchObject({ caller_session_id: "caller-sess-1", folderId: "caller-folder", caller_info: callerInfo });
  });
  it("명시 caller_session_id가 MCP 요청 header보다 우선한다", async () => {
    const f = fixture();
    expect((await f.call("create_remote_agent_session", remote, { ...context, callerSessionId: "stale-header-sess" })).isError).not.toBe(true);
    expect(f.prepare.mock.calls[0]![0].body).toMatchObject({ caller_session_id: "caller-sess-1", folderId: "caller-folder" });
    expect(f.readSession).toHaveBeenCalledWith("caller-sess-1");
  });
  it("folder_id를 명시하지 않으면 caller session 폴더를 remote body에 상속한다", async () => {
    const f = fixture();
    expect((await f.call("create_remote_agent_session", remote)).isError).not.toBe(true);
    expect(f.prepare.mock.calls[0]![0].body.folderId).toBe("caller-folder");
  });
  it("notify_completion=false도 caller의 폴더와 provenance를 remote body에 보존한다", async () => {
    const f = fixture(); f.readSession.mockResolvedValue({ folder_id: "root" });
    expect((await f.call("create_remote_agent_session", { ...remote, notify_completion: false })).isError).not.toBe(true);
    const body = f.prepare.mock.calls[0]![0].body;
    expect(body).toMatchObject({ folderId: "root", notify_completion: false, caller_session_id: "caller-sess-1", caller_info: callerInfo });
    expect(body).not.toHaveProperty("container");
  });
  it("folder_id=null은 caller folder 상속 없이 root 의도로 전달한다", async () => {
    const f = fixture();
    expect((await f.call("create_remote_agent_session", { ...remote, folder_id: null })).isError).not.toBe(true);
    expect(f.prepare.mock.calls[0]![0].body.folderId).toBeNull();
    expect(f.readSession).not.toHaveBeenCalled();
  });
  it("caller id를 알 수 없으면 remote orphan 세션을 만들지 않는다", async () => {
    const f = fixture();
    const { caller_session_id: _caller, ...args } = remote;
    expect(await f.call("create_remote_agent_session", args, { ...context, callerSessionId: null })).toMatchObject({ isError: true, structuredContent: { error: expect.stringContaining("caller_session_id") } });
    expect(f.createSession).not.toHaveBeenCalled();
  });
  it("dedicated external ingress는 부모 없이 remote session에 external-llm을 전달한다", async () => {
    const f = fixture();
    const externalInfo = { source: "external-llm", agent_node: "node-test", display_name: "External LLM", user_id: null, avatar_url: null };
    expect((await f.call("create_remote_agent_session", { ...remote, prompt: "external remote delegation", caller_session_id: "spoofed-session" }, { ...context, principal: "external", callerInfo: externalInfo })).isError).not.toBe(true);
    const body = f.prepare.mock.calls[0]![0].body;
    expect(body).not.toHaveProperty("caller_session_id");
    expect(body.caller_info).toEqual(externalInfo);
  });
});

describe("remote agent config tools", () => {
  it("proxies read-only profile update planning to the orchestrator node provider", async () => {
    const f = fixture();
    const result = { ok: true, config_path: "/srv/agents.yaml", changed: true, semantic_changes: [{ op: "add_agent", agent_id: "codex-default", before: null, after: { id: "codex-default", name: "Codex Planned", backend: "codex", workspace_dir: "/tmp/codex" } }], text_diff_included: true, diff: "--- agents.yaml\n+++ agents.yaml\n", comment_preservation: "not_preserved" };
    f.profiles.planAgentProfileUpdate.mockResolvedValue(result);
    const profile = result.semantic_changes[0]!.after;
    expect(await f.call("plan_remote_agent_profile_update", { node_id: "node-remote", create_if_missing: true, include_text_diff: true, profile })).toMatchObject({ structuredContent: result });
    expect(f.profiles.planAgentProfileUpdate).toHaveBeenCalledWith("node-remote", { profile: expect.objectContaining(profile), createIfMissing: true, includeTextDiff: true });
  });
  it("apply_remote_agent_profile_update proxies write request with checksum guard", async () => {
    const f = fixture();
    const result = { ok: true, changed: true, snapshot_path: "/srv/snap.yaml", config_checksum: "next-checksum", base_config_checksum: "base-checksum", semantic_changes: [{ op: "replace_agent", agent_id: "codex-default" }], text_diff_included: false, diff: "", reload_ok: true };
    f.profiles.applyAgentProfileUpdate.mockResolvedValue(result);
    const profile = { id: "codex-default", name: "Codex Applied", backend: "codex", workspace_dir: "/tmp/codex" };
    expect(await f.call("apply_remote_agent_profile_update", { node_id: "node-remote", create_if_missing: true, expected_config_checksum: "base-checksum", profile })).toMatchObject({ structuredContent: result });
    expect(f.profiles.applyAgentProfileUpdate).toHaveBeenCalledWith("node-remote", { profile: expect.objectContaining(profile), createIfMissing: true, includeTextDiff: false, expectedConfigChecksum: "base-checksum" });
  });
  it("list_remote_agents_config_snapshots proxies snapshot inventory request", async () => {
    const f = fixture(); const result = { ok: true, snapshots: [{ snapshot_id: "snap.yaml", snapshot_path: "/srv/snap.yaml" }] };
    f.profiles.listAgentsConfigSnapshots.mockResolvedValue(result);
    expect(await f.call("list_remote_agents_config_snapshots", { node_id: "node-remote" })).toMatchObject({ structuredContent: result });
    expect(f.profiles.listAgentsConfigSnapshots).toHaveBeenCalledWith("node-remote");
  });
  it("rollback_remote_agents_config proxies snapshot id rollback request", async () => {
    const f = fixture(); const result = { ok: true, changed: true, snapshot_path: "/srv/pre-rollback.yaml", config_checksum: "restored-checksum", reload_ok: true };
    f.profiles.rollbackAgentsConfig.mockResolvedValue(result);
    expect(await f.call("rollback_remote_agents_config", { node_id: "node-remote", snapshot_id: "snap.yaml", include_text_diff: true })).toMatchObject({ structuredContent: result });
    expect(f.profiles.rollbackAgentsConfig).toHaveBeenCalledWith("node-remote", { snapshotId: "snap.yaml", snapshotPath: undefined, includeTextDiff: true });
  });
});

it("proxies orchestrator aggregate without colliding with self reflect_brief", async () => {
  const f = fixture();
  f.options.cluster.cogito = { provider: { listConnectedNodes: () => [{ id: "node-remote", host: "node", port: 4105, capabilities: { reflect_brief: true } }] }, briefCollector: { reflectBrief: async () => ({ brief: { kind: "compact_aggregate" } }) }, searchProvider: {} as never };
  expect(await f.call("reflect_cluster_brief", {})).toMatchObject({ structuredContent: { schema_version: "soulstream.reflect.aggregate.v1", kind: "orchestrator_node_brief_aggregate", nodes: [expect.objectContaining({ node_id: "node-remote", status: "ok" })] } });
});

it("rejects every recurring operation for an untrusted external caller", async () => {
  const f = fixture();
  const required = { job_id: "job-1", expected_version: 1, ...createInput, run_at: "2026-09-29T09:00:00+09:00" };
  for (const name of Object.keys(recurringJobTools) as Array<keyof typeof recurringJobTools>) {
    expect(await f.call(name, { ...required, caller_session_id: "also-spoofed" }, { ...context, principal: "external", callerSessionId: "spoofed-session" })).toMatchObject({ isError: true, structuredContent: { error: "Recurring-job tools require a registered external agent." } });
  }
});

it("does not call policy provider for external or missing caller, and surfaces host admin refusal", async () => {
  const f = fixture();
  const resolveCaller = vi.fn(async () => ({ ownerEmail: "not-admin@example.com", purpose: null }));
  f.options.cardOrchestration = { resolveCaller, isAdminEmail: async () => false } as never;
  expect((await f.call("get_card_orchestration_settings", {}, { ...context, principal: "external", callerSessionId: "spoofed" })).isError).toBe(true);
  expect((await f.call("get_card_orchestration_settings", {}, { ...context, callerSessionId: null })).isError).toBe(true);
  expect(resolveCaller).not.toHaveBeenCalled();
  expect((await f.call("get_card_orchestration_settings", {}, { ...context, callerSessionId: "native-caller" })).isError).toBe(true);
  expect(resolveCaller).toHaveBeenCalledOnce();
});

it("binds policy operations to the request session header and rejects a spoofed explicit administrator session", async () => {
  const f = fixture();
  const resolveCaller = vi.fn(async () => ({ ownerEmail: "admin@example.com", purpose: null }));
  const get = vi.fn(async () => ({ version: 1 }));
  f.options.cardOrchestration = { resolveCaller, get, isAdminEmail: async () => true } as never;
  expect((await f.call("get_card_orchestration_settings", { caller_session_id: "different-admin" }, { ...context, callerSessionId: "real-header" })).isError).toBe(true);
  expect(resolveCaller).not.toHaveBeenCalled();
  expect((await f.call("get_card_orchestration_settings", { caller_session_id: "real-header" }, { ...context, callerSessionId: "real-header" })).isError).not.toBe(true);
  expect(resolveCaller).toHaveBeenCalledWith("real-header");
});

it("uses the verified normal caller-session actor for query, creation, and update", async () => {
  const f = fixture();
  const list = vi.fn(async () => []);
  const create = vi.fn(async () => ({ jobId: "job-1" }));
  const update = vi.fn(async () => ({ jobId: "job-1", version: 2 }));
  f.options.recurringJobs = { service: { list, create, update } } as never;
  f.options.resolveSessionOwner = vi.fn(async () => ({ ownerEmail: "owner@example.com", callerInfo }));
  const c = { ...context, callerSessionId: "caller-session", callerInfo: { email: "unverified@example.com" } };
  expect((await f.call("list_recurring_jobs", {}, c)).isError).not.toBe(true);
  expect(await f.call("create_recurring_job", createInput, c)).toMatchObject({ structuredContent: { job: { job_id: "job-1" } } });
  expect(await f.call("update_recurring_job", { job_id: "job-1", expected_version: 1, enabled: true }, c)).toMatchObject({ structuredContent: { job: { job_id: "job-1", version: 2 } } });
  const actor = { ownerEmail: "owner@example.com", actorId: "caller-session", source: "agent", callerInfo: { email: "owner@example.com" } };
  expect(list).toHaveBeenCalledWith(actor, false);
  expect(create).toHaveBeenCalledWith(actor, expect.objectContaining({ name: "music recommendation", idempotencyKey: "recurring:create:1", enabled: false }));
  expect(update).toHaveBeenCalledWith(actor, "job-1", { expectedVersion: 1, enabled: true });
  expect(f.options.resolveSessionOwner).toHaveBeenCalledWith("caller-session");
});
