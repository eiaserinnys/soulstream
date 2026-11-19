import { describe, expect, it, vi } from "vitest";

import {
  InMemoryNodeRegistry,
  NodeCommandTransportHub,
  SessionCommandTransportBridge,
  loadContractFixtures,
  type NodeRegistrationPayload,
} from "../src/index.js";
import { ClaudeCentralService } from "../src/claude_central/service.js";
import {
  CENTRAL_ACCOUNT_ID,
  CENTRAL_NOW_MS,
  InMemoryClaudeCentralAccountRepository,
  InMemoryClaudeCentralSettingsRepository,
  centralAccountRecord,
  jsonResponse,
} from "./claude-central-test-support.js";

const USAGE_BODY = {
  five_hour: { utilization: 12.5, resets_at: "2026-11-19T05:00:00.000Z" },
  seven_day: { utilization: 47, resets_at: "2026-11-25T03:00:00.000Z" },
  limits: [{ kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, percent: 8 }],
};

function createServiceHarness(options: {
  repository?: InMemoryClaudeCentralAccountRepository;
  settings?: InMemoryClaudeCentralSettingsRepository;
  fetch?: typeof fetch;
  registerNode?: boolean;
} = {}) {
  const repository = options.repository ?? new InMemoryClaudeCentralAccountRepository();
  const settings = options.settings ?? new InMemoryClaudeCentralSettingsRepository();
  const registry = new InMemoryNodeRegistry({
    nowMs: () => CENTRAL_NOW_MS,
    requestIdGenerator: ({ sequence, commandType }) => `${commandType}-${sequence}`,
  });
  let nodeId: string | undefined;
  let connectionId: string | undefined;
  const transports = new NodeCommandTransportHub();
  const sent: Array<Record<string, unknown>> = [];
  if (options.registerNode ?? true) {
    const registration = loadContractFixtures().fakeNodeReconnect
      .registration as NodeRegistrationPayload;
    const registered = registry.registerNode({
      ...registration,
      capabilities: { ...(registration.capabilities ?? {}), claude_account_pool_v1: true },
    });
    nodeId = registered.node.nodeId;
    connectionId = registered.node.connectionId;
    transports.attach({
      nodeId,
      connectionId,
      transport: {
        send: (data) => {
          const message = JSON.parse(data) as Record<string, unknown>;
          sent.push(message);
          registry.receiveNodeMessage({ nodeId: nodeId!, connectionId: connectionId! }, {
            type: `${String(message.type)}_ack`,
            requestId: message.requestId,
            success: true,
            ok: true,
            revision: message.revision,
          });
        },
      },
    });
  }
  const bridge = new SessionCommandTransportBridge({ registry, transports });
  const notifyRelogin = vi.fn();
  const onWarning = vi.fn();
  const service = new ClaudeCentralService({
    repository,
    settingsRepository: settings,
    registry,
    bridge,
    clientId: () => "claude-client-id",
    notifyRelogin,
    onWarning,
    now: () => CENTRAL_NOW_MS,
    fetch: options.fetch,
  });
  return { service, repository, settings, sent, notifyRelogin, onWarning, nodeId };
}

describe("central Claude service", () => {
  it("lists accounts without either token and with the central-only fields", async () => {
    const repository = new InMemoryClaudeCentralAccountRepository([
      centralAccountRecord({
        reloginReason: "refresh_rejected",
        refreshedAt: "2026-11-19T02:30:00.000Z",
        expiresAt: "2026-11-19T10:00:00.000Z",
      }),
    ]);
    const { service } = createServiceHarness({ repository, registerNode: false });

    const list = await service.getAccountList();
    expect(list.mode).toBe("pool");
    expect(list.accounts).toHaveLength(1);
    expect(list.accounts[0]).toMatchObject({
      id: CENTRAL_ACCOUNT_ID,
      email: "central@example.com",
      plan: "max",
      enabled: true,
      priority: 0,
      auth_state: "ok",
      usage: { five_hour: null, seven_day: null, fable_weekly: null },
      observed_at: null,
      blocked: null,
      active_sessions: 0,
      expires_at: "2026-11-19T10:00:00.000Z",
      refreshed_at: "2026-11-19T02:30:00.000Z",
      relogin_reason: "refresh_rejected",
    });
    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain("access-token-1");
    expect(serialized).not.toContain("refresh-token-1");
    expect(serialized).not.toContain("access_token");
    expect(serialized).not.toContain("refresh_token");
  });

  it("projects the last usage observation into the account usage windows", async () => {
    const repository = new InMemoryClaudeCentralAccountRepository([centralAccountRecord()]);
    const fetchImpl = vi.fn(async () => jsonResponse(USAGE_BODY));
    const { service } = createServiceHarness({
      repository,
      registerNode: false,
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await service.usage.runOnce();
    const list = await service.getAccountList();

    expect(list.accounts[0]).toMatchObject({
      observed_at: new Date(CENTRAL_NOW_MS).toISOString(),
      usage: {
        five_hour: { used_percent: 12.5, resets_at: "2026-11-19T05:00:00.000Z" },
        seven_day: { used_percent: 47, resets_at: "2026-11-25T03:00:00.000Z" },
        fable_weekly: { used_percent: 8, resets_at: null },
      },
    });
    expect(list.pool.total_count).toBe(1);
    expect(list.pool.available_count).toBe(1);
  });

  it("notifies a re-login need once per transition and pushes a sync after the change", async () => {
    const repository = new InMemoryClaudeCentralAccountRepository([
      centralAccountRecord({ expiresAt: null }),
    ]);
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "invalid_grant" }, 401));
    const { service, notifyRelogin, sent } = createServiceHarness({
      repository,
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await service.refresh.runOnce();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(notifyRelogin).toHaveBeenCalledTimes(1);
    expect(notifyRelogin).toHaveBeenCalledWith({
      accountId: CENTRAL_ACCOUNT_ID,
      accountEmail: "central@example.com",
    });
    expect((await repository.findById(CENTRAL_ACCOUNT_ID))?.authState).toBe("needs_relogin");
    expect(sent.filter((message) => message.type === "claude_central_pool_sync").length)
      .toBeGreaterThanOrEqual(1);

    await service.refresh.runOnce();
    expect(notifyRelogin).toHaveBeenCalledTimes(1);
  });

  it("pushes the usage snapshot to the node at the end of a usage cycle", async () => {
    const repository = new InMemoryClaudeCentralAccountRepository([centralAccountRecord()]);
    const fetchImpl = vi.fn(async () => jsonResponse(USAGE_BODY));
    const { service, sent } = createServiceHarness({
      repository,
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await service.usage.runOnce();
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    const sync = sent.filter((message) => message.type === "claude_central_pool_sync").at(-1);
    expect(sync?.accounts).toMatchObject([{
      id: CENTRAL_ACCOUNT_ID,
      access_token: "access-token-1",
      usage_raw: USAGE_BODY,
      usage_fetched_at: new Date(CENTRAL_NOW_MS).toISOString(),
    }]);
  });

  it("syncs after an account update and a deletion", async () => {
    const repository = new InMemoryClaudeCentralAccountRepository([centralAccountRecord()]);
    const { service, sent } = createServiceHarness({ repository });

    const list = await service.patchAccount(CENTRAL_ACCOUNT_ID, { enabled: false });
    expect(list.accounts[0]?.enabled).toBe(false);
    expect(sent.at(-1)).toMatchObject({
      type: "claude_central_pool_sync",
      accounts: [expect.objectContaining({ id: CENTRAL_ACCOUNT_ID, enabled: false, access_token: null })],
    });

    const beforeDelete = sent.length;
    expect(await service.deleteAccount(CENTRAL_ACCOUNT_ID)).toBe(true);
    expect(sent.length).toBeGreaterThan(beforeDelete);
    expect(sent.at(-1)).toMatchObject({ type: "claude_central_pool_sync", accounts: [] });
    expect(await service.deleteAccount(CENTRAL_ACCOUNT_ID)).toBe(false);
  });

  it("computes effective receive settings from the default, node overrides, and connected nodes", async () => {
    const settings = new InMemoryClaudeCentralSettingsRepository({
      default_receive: false,
      nodes: { "not-connected": true },
    });
    const { service, nodeId } = createServiceHarness({ settings });

    const view = await service.getSettings();
    expect(view.default_receive).toBe(false);
    expect(view.nodes).toEqual({ "not-connected": true });
    expect(view.effective).toEqual([
      { node_id: nodeId!, receive: false, connected: true },
      { node_id: "not-connected", receive: true, connected: false },
    ]);
  });

  it("deletes a node override when the value is null and syncs the new settings", async () => {
    const settings = new InMemoryClaudeCentralSettingsRepository({
      default_receive: true,
      nodes: { "node-x": false },
    });
    const { service, sent } = createServiceHarness({ settings });

    const updated = await service.updateSettings({ nodes: { "node-x": null } });
    expect(updated.nodes).toEqual({});
    expect(settings.current.nodes).toEqual({});
    expect(sent.at(-1)?.type).toBe("claude_central_pool_sync");
  });
});
