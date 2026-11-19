import { describe, expect, it, vi } from "vitest";

import {
  InMemoryNodeRegistry,
  NodeCommandTransportHub,
  SessionCommandTransportBridge,
  loadContractFixtures,
  type NodeRegistrationPayload,
} from "../src/index.js";
import { ClaudeCentralPoolSyncService } from "../src/claude_central/pool_sync_service.js";
import type { ClaudeCentralPoolSyncAccount } from "../src/claude_central/types.js";
import {
  CENTRAL_ACCOUNT_ID,
  CENTRAL_NOW_MS,
  InMemoryClaudeCentralSettingsRepository,
} from "./claude-central-test-support.js";

type SyncHarnessOptions = {
  accounts?: readonly ClaudeCentralPoolSyncAccount[];
  defaultReceive?: boolean;
  nodes?: Record<string, boolean>;
  poolCapable?: boolean;
  ackFor?: (message: Record<string, unknown>) => Record<string, unknown>;
};

function createSyncHarness(options: SyncHarnessOptions = {}) {
  const registry = new InMemoryNodeRegistry({
    nowMs: () => CENTRAL_NOW_MS,
    requestIdGenerator: ({ sequence, commandType }) => `${commandType}-${sequence}`,
  });
  const registration = loadContractFixtures().fakeNodeReconnect
    .registration as NodeRegistrationPayload;
  const registered = registry.registerNode(
    options.poolCapable === false
      ? registration
      : {
          ...registration,
          capabilities: { ...(registration.capabilities ?? {}), claude_account_pool_v1: true },
        },
  );
  const nodeId = registered.node.nodeId;
  const connectionId = registered.node.connectionId;
  const transports = new NodeCommandTransportHub();
  const sent: Array<Record<string, unknown>> = [];
  transports.attach({
    nodeId,
    connectionId,
    transport: {
      send: (data) => {
        const message = JSON.parse(data) as Record<string, unknown>;
        sent.push(message);
        const ack = options.ackFor?.(message) ?? {
          type: `${String(message.type)}_ack`,
          success: true,
          ok: true,
          revision: message.revision,
        };
        registry.receiveNodeMessage({ nodeId, connectionId }, { ...ack, requestId: message.requestId });
      },
    },
  });
  const bridge = new SessionCommandTransportBridge({ registry, transports });
  const settings = new InMemoryClaudeCentralSettingsRepository({
    default_receive: options.defaultReceive ?? true,
    nodes: options.nodes ?? {},
  });
  const onWarning = vi.fn();
  const accounts = options.accounts ?? [];
  const service = new ClaudeCentralPoolSyncService({
    registry,
    bridge,
    settings,
    listAccounts: async () => accounts,
    now: () => CENTRAL_NOW_MS,
    onWarning,
  });
  return { service, sent, nodeId, connectionId, onWarning, settings };
}

function syncAccount(
  overrides: Partial<ClaudeCentralPoolSyncAccount> = {},
): ClaudeCentralPoolSyncAccount {
  return {
    id: CENTRAL_ACCOUNT_ID,
    email: "central@example.com",
    plan: "max",
    enabled: true,
    priority: 0,
    auth_state: "ok",
    relogin_reason: null,
    access_token: "access-token-1",
    expires_at: "2026-11-19T11:00:00.000Z",
    usage_raw: { seven_day: { utilization: 10 } },
    usage_fetched_at: "2026-11-19T02:56:00.000Z",
    ...overrides,
  };
}

describe("central Claude pool sync", () => {
  it("sends the contract payload with a Date.now() revision when the node receives the pool", async () => {
    const accounts = [syncAccount()];
    const harness = createSyncHarness({ accounts });

    expect(await harness.service.sendToNode(harness.nodeId)).toBe(true);

    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]).toMatchObject({
      type: "claude_central_pool_sync",
      revision: CENTRAL_NOW_MS,
      receive: true,
      accounts,
    });
  });

  it("sends an empty accounts array when the node is set not to receive the central pool", async () => {
    const harness = createSyncHarness({ accounts: [syncAccount()] });
    harness.settings.current = { default_receive: true, nodes: { [harness.nodeId]: false } };

    await harness.service.sendToNode(harness.nodeId);

    expect(harness.sent[0]).toMatchObject({ receive: false, accounts: [] });
  });

  it("omits the access token for accounts that need a re-login or are disabled", async () => {
    const accounts = [
      syncAccount(),
      syncAccount({
        id: "22222222-2222-4222-8222-222222222222",
        auth_state: "needs_relogin",
        relogin_reason: "refresh_rejected",
        access_token: null,
      }),
      syncAccount({
        id: "33333333-3333-4333-8333-333333333333",
        enabled: false,
        access_token: null,
      }),
    ];
    const harness = createSyncHarness({ accounts });

    await harness.service.sendToNode(harness.nodeId);

    const payloadAccounts = harness.sent[0]?.accounts as Array<Record<string, unknown>>;
    expect(payloadAccounts.map((account) => account.access_token))
      .toEqual(["access-token-1", null, null]);
  });

  it("sends once right after a node registration event", async () => {
    const harness = createSyncHarness();

    harness.service.acceptNodeEvents([
      { type: "node_registered", nodeId: harness.nodeId, connectionId: harness.connectionId },
    ]);
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]?.type).toBe("claude_central_pool_sync");
  });

  it("warns once for a node that does not implement the command and stops sending to that connection", async () => {
    const harness = createSyncHarness({
      ackFor: (message) => ({
        type: "error",
        success: false,
        status: "rejected",
        code: "CONTROL_COMMAND_NOT_IN_INVENTORY",
        message: `Not implemented in soul-server-ts: ${String(message.type)}`,
      }),
    });

    expect(await harness.service.sendToNode(harness.nodeId)).toBe(false);
    expect(harness.onWarning).toHaveBeenCalledTimes(1);
    expect(String(harness.onWarning.mock.calls[0]?.[0])).toContain("claude_central_pool_sync");

    expect(await harness.service.sendToNode(harness.nodeId)).toBe(false);
    expect(harness.sent).toHaveLength(1);
    expect(harness.onWarning).toHaveBeenCalledTimes(1);
  });

  it("skips nodes that do not advertise the Claude account pool capability", async () => {
    const harness = createSyncHarness({ poolCapable: false });

    expect(await harness.service.sendToNode(harness.nodeId)).toBe(false);
    expect(harness.sent).toHaveLength(0);
  });
});
