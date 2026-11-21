import { describe, expect, it, vi } from "vitest";

import {
  InMemoryNodeRegistry,
  NodeCommandTransportHub,
  SessionCommandTransportBridge,
  loadContractFixtures,
  type NodeRegistrationPayload,
} from "../src/index.js";
import type { ClaudeCentralPoolAccount } from "@soulstream/wire-schema";
import { ClaudeCentralPoolSyncService } from "../src/claude_central/pool_sync_service.js";
import {
  CENTRAL_ACCOUNT_ID,
  CENTRAL_NOW_MS,
  InMemoryClaudeCentralSettingsRepository,
} from "./claude-central-test-support.js";

type SyncHarnessOptions = {
  accounts?: readonly ClaudeCentralPoolAccount[];
  defaultReceive?: boolean;
  nodes?: Record<string, boolean>;
  poolCapable?: boolean;
  ackFor?: (message: Record<string, unknown>) => Record<string, unknown> | null | undefined;
  listAccounts?: () => Promise<readonly ClaudeCentralPoolAccount[]>;
  timeoutMs?: number;
  extraNodes?: number;
};

function createSyncHarness(options: SyncHarnessOptions = {}) {
  const registry = new InMemoryNodeRegistry({
    nowMs: () => CENTRAL_NOW_MS,
    requestIdGenerator: ({ sequence, commandType }) => `${commandType}-${sequence}`,
  });
  const registration = loadContractFixtures().fakeNodeReconnect
    .registration as NodeRegistrationPayload;
  const register = (nodeId?: string) => registry.registerNode(
    options.poolCapable === false
      ? { ...registration, ...(nodeId === undefined ? {} : { node_id: nodeId }) }
      : {
          ...registration,
          ...(nodeId === undefined ? {} : { node_id: nodeId }),
          capabilities: { ...(registration.capabilities ?? {}), claude_account_pool_v1: true },
        },
  );
  const registered = register();
  const nodeId = registered.node.nodeId;
  const connectionId = registered.node.connectionId;
  const extraRegistered = Array.from(
    { length: options.extraNodes ?? 0 },
    (_, index) => register(`sync-node-${index + 2}`),
  );
  const transports = new NodeCommandTransportHub();
  const sent: Array<Record<string, unknown>> = [];
  const sentByNode = new Map<string, Array<Record<string, unknown>>>();
  const attach = (
    node: { nodeId: string; connectionId: string },
    record: Array<Record<string, unknown>>,
  ) => {
    sentByNode.set(node.nodeId, record);
    transports.attach({
      nodeId: node.nodeId,
      connectionId: node.connectionId,
      transport: {
        send: (data) => {
          const message = JSON.parse(data) as Record<string, unknown>;
          record.push(message);
          const ack = options.ackFor === undefined
            ? defaultAck(message)
            : options.ackFor(message);
          if (ack === null) return;
          registry.receiveNodeMessage(
            { nodeId: node.nodeId, connectionId: node.connectionId },
            { ...ack, requestId: message.requestId },
          );
        },
      },
    });
  };
  attach(registered.node, sent);
  for (const extra of extraRegistered) attach(extra.node, []);
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
    listAccounts: options.listAccounts ?? (async () => accounts),
    now: () => CENTRAL_NOW_MS,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    onWarning,
  });
  return {
    service,
    sent,
    sentByNode,
    nodeId,
    connectionId,
    extraNodeIds: extraRegistered.map((extra) => extra.node.nodeId),
    onWarning,
    settings,
  };
}

function defaultAck(message: Record<string, unknown>): Record<string, unknown> {
  return {
    type: `${String(message.type)}_ack`,
    success: true,
    ok: true,
    revision: message.revision,
  };
}

function syncAccount(
  overrides: Partial<ClaudeCentralPoolAccount> = {},
): ClaudeCentralPoolAccount {
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

  it("serializes per-node sends and resends the settings read after the queued request", async () => {
    const accounts = [syncAccount()];
    let releaseAccounts!: () => void;
    const accountsGate = new Promise<void>((resolve) => { releaseAccounts = resolve; });
    let listCalls = 0;
    const harness = createSyncHarness({
      listAccounts: async () => {
        listCalls += 1;
        await accountsGate;
        return accounts;
      },
    });

    const first = harness.service.sendToNode(harness.nodeId);
    await vi.waitFor(() => { expect(listCalls).toBe(1); });

    harness.settings.current = {
      default_receive: true,
      nodes: { [harness.nodeId]: false },
    };
    const second = harness.service.sendToNode(harness.nodeId);
    releaseAccounts();

    expect(await first).toBe(true);
    expect(await second).toBe(true);

    expect(harness.sent).toHaveLength(2);
    expect(harness.sent[0]).toMatchObject({ receive: true, accounts });
    expect(harness.sent[1]).toMatchObject({ receive: false, accounts: [] });
    expect(Number(harness.sent[1]?.revision)).toBeGreaterThan(
      Number(harness.sent[0]?.revision),
    );
  });

  it("keeps revisions strictly increasing for one node when the clock does not move", async () => {
    const harness = createSyncHarness();

    await harness.service.sendToNode(harness.nodeId);
    await harness.service.sendToNode(harness.nodeId);

    expect(harness.sent).toHaveLength(2);
    expect(Number(harness.sent[1]?.revision)).toBeGreaterThan(
      Number(harness.sent[0]?.revision),
    );
  });

  it("continues with the next send after a rejected send", async () => {
    let firstResponse = true;
    const harness = createSyncHarness({
      ackFor: (message) => {
        if (!firstResponse) return defaultAck(message);
        firstResponse = false;
        return { type: "error", success: false, message: "node rejected the command" };
      },
    });

    expect(await harness.service.sendToNode(harness.nodeId)).toBe(false);
    expect(await harness.service.sendToNode(harness.nodeId)).toBe(true);
    expect(harness.sent).toHaveLength(2);
  });

  it("continues with the next send after a timed-out send", async () => {
    let firstResponse = true;
    const harness = createSyncHarness({
      timeoutMs: 20,
      ackFor: (message) => {
        if (!firstResponse) return defaultAck(message);
        firstResponse = false;
        return null;
      },
    });

    expect(await harness.service.sendToNode(harness.nodeId)).toBe(false);
    expect(await harness.service.sendToNode(harness.nodeId)).toBe(true);
    expect(harness.sent).toHaveLength(2);
  });

  it("does not let one node's send block another node's send", async () => {
    let firstMessage = true;
    const harness = createSyncHarness({
      timeoutMs: 100,
      extraNodes: 1,
      ackFor: (message) => {
        if (!firstMessage) return defaultAck(message);
        firstMessage = false;
        return null;
      },
    });
    const [otherNodeId] = harness.extraNodeIds;

    const blocked = harness.service.sendToNode(harness.nodeId);
    await vi.waitFor(() => { expect(harness.sent).toHaveLength(1); }, { interval: 5 });
    const other = await harness.service.sendToNode(otherNodeId!);

    expect(other).toBe(true);
    expect(harness.sentByNode.get(otherNodeId!)).toHaveLength(1);
    expect(await blocked).toBe(false);
  });
});
