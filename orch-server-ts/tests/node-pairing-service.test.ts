import { describe, expect, it } from "vitest";

import {
  NodeCredentialStore,
  NodePairingError,
  NodePairingService,
} from "../src/node_credentials/index.js";
import { InMemoryNodeCredentialRepository } from "./node-credentials-test-support.js";

const START_NOW = 1_790_000_000_000;

async function createHarness() {
  const repository = new InMemoryNodeCredentialRepository();
  const store = new NodeCredentialStore({ repository });
  await store.initialize();
  const connected = new Set<string>();
  const stored = new Set<string>();
  let now = START_NOW;
  const scheduled: Array<() => void> = [];
  const cleared: unknown[] = [];
  const service = new NodePairingService({
    store,
    isNodeConnected: nodeId => connected.has(nodeId),
    hasStoredNode: nodeId => stored.has(nodeId),
    now: () => now,
    setTimer: callback => {
      scheduled.push(callback);
      return scheduled.length;
    },
    clearTimer: handle => {
      cleared.push(handle);
    },
  });
  return {
    repository,
    store,
    service,
    connected,
    stored,
    scheduled,
    cleared,
    advance(ms: number) {
      now += ms;
    },
    now: () => now,
    runExpiryTimers() {
      for (const callback of [...scheduled]) callback();
    },
  };
}

describe("NodePairingService", () => {
  it("runs the whole pairing flow and hands the token out only once", async () => {
    const harness = await createHarness();

    const start = await harness.service.start({ node_id: "node-a", company_pc: true });

    expect(start).toMatchObject({ interval_secs: 3 });
    expect(start.device_code.length).toBeGreaterThanOrEqual(43);
    expect(start.user_code).toMatch(/^[2-9A-HJ-KM-NP-TV-Z]{4}-[2-9A-HJ-KM-NP-TV-Z]{4}$/);
    expect(start.expires_at).toBe(new Date(START_NOW + 10 * 60 * 1000).toISOString());

    await expect(harness.service.poll(start.device_code)).resolves.toEqual({ status: "pending" });

    const approval = await harness.service.approve(start.user_code);

    expect(Object.keys(approval).sort()).toEqual(["company_pc", "credential_id", "node_id"]);
    expect(JSON.stringify(approval)).not.toContain("token");

    const approved = await harness.service.poll(start.device_code);

    expect(approved).toMatchObject({
      status: "approved",
      node_id: "node-a",
      company_pc: true,
    });
    if (approved.status !== "approved") throw new Error("expected approved");
    expect(harness.store.resolve(approved.token)).toEqual(approval);
    expect(JSON.stringify(approved)).not.toContain(start.device_code);

    await expect(harness.service.poll(start.device_code)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("normalizes the user code and re-approving returns the same credential", async () => {
    const harness = await createHarness();
    const start = await harness.service.start({ node_id: "node-b", company_pc: false });

    const first = await harness.service.approve(start.user_code);
    const again = await harness.service.approve(
      `  ${start.user_code.toLowerCase().replace("-", " - ")}  `,
    );

    expect(again).toEqual(first);
    expect(harness.repository.rows).toHaveLength(1);
  });

  it("approving the same user code concurrently yields one credential for both callers", async () => {
    const harness = await createHarness();
    const start = await harness.service.start({ node_id: "node-h", company_pc: true });

    const [first, second] = await Promise.all([
      harness.service.approve(start.user_code),
      harness.service.approve(start.user_code),
    ]);

    expect(second).toEqual(first);
    expect(harness.repository.rows).toHaveLength(1);
    expect(harness.store.hasActiveNode("node-h")).toBe(true);
  });

  it("releases the in-flight approval after a failure so a retry can succeed", async () => {
    const harness = await createHarness();
    const start = await harness.service.start({ node_id: "node-i", company_pc: true });
    harness.repository.failNextInsert = true;

    await expect(harness.service.approve(start.user_code))
      .rejects.toThrow("database unavailable");

    const approval = await harness.service.approve(start.user_code);
    expect(approval.node_id).toBe("node-i");
    expect(harness.repository.rows).toHaveLength(1);
  });

  it("drops the plaintext token and device code when the TTL elapses without a poll", async () => {
    const harness = await createHarness();
    const start = await harness.service.start({ node_id: "node-j", company_pc: true });
    const approval = await harness.service.approve(start.user_code);
    expect(approval.node_id).toBe("node-j");

    const internals = harness.service as unknown as {
      byDeviceCode: Map<string, { token?: string }>;
      byUserCode: Map<string, unknown>;
    };
    expect(internals.byDeviceCode.get(start.device_code)?.token).toBeTypeOf("string");

    harness.advance(10 * 60 * 1000 + 1);
    harness.runExpiryTimers();

    expect(internals.byDeviceCode.size).toBe(0);
    expect(internals.byUserCode.size).toBe(0);
  });

  it("expires pairings after ten minutes and treats them as missing", async () => {
    const harness = await createHarness();
    const start = await harness.service.start({ node_id: "node-c", company_pc: true });

    harness.advance(10 * 60 * 1000 + 1);

    await expect(harness.service.poll(start.device_code)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(harness.service.approve(start.user_code)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("refuses a new pairing when twenty are already pending", async () => {
    const harness = await createHarness();

    for (let index = 0; index < 20; index += 1) {
      await harness.service.start({ node_id: `node-${index}`, company_pc: false });
    }

    await expect(harness.service.start({ node_id: "node-overflow", company_pc: false }))
      .rejects.toMatchObject({ code: "limit" });
  });

  it("rejects malformed node ids and non-boolean company_pc", async () => {
    const harness = await createHarness();

    for (const nodeId of ["Node-A", "-node", "a", "node_a", "a".repeat(64), 42, null]) {
      await expect(harness.service.start({ node_id: nodeId, company_pc: true }))
        .rejects.toMatchObject({ code: "invalid_input" });
    }
    for (const companyPc of [undefined, "true", 1]) {
      await expect(harness.service.start({ node_id: "node-valid", company_pc: companyPc }))
        .rejects.toMatchObject({ code: "invalid_input" });
    }
  });

  it("rejects approval when the node already has an active credential", async () => {
    const harness = await createHarness();
    await harness.store.createCredential({ node_id: "node-d", company_pc: true });
    const start = await harness.service.start({ node_id: "node-d", company_pc: true });

    await expect(harness.service.approve(start.user_code)).rejects.toMatchObject({
      code: "conflict",
      conflictReason: "active_credential",
    });
    expect(harness.repository.rows).toHaveLength(1);
  });

  it("rejects approval when the node is currently connected", async () => {
    const harness = await createHarness();
    harness.connected.add("node-e");
    const start = await harness.service.start({ node_id: "node-e", company_pc: false });

    await expect(harness.service.approve(start.user_code)).rejects.toMatchObject({
      code: "conflict",
      conflictReason: "connected",
    });
    expect(harness.repository.rows).toHaveLength(0);
  });

  it("rejects approval when the orchestrator stored the node while it was offline", async () => {
    const harness = await createHarness();
    harness.stored.add("node-f");
    const start = await harness.service.start({ node_id: "node-f", company_pc: false });

    await expect(harness.service.approve(start.user_code)).rejects.toMatchObject({
      code: "conflict",
      conflictReason: "stored_node",
    });
    expect(harness.repository.rows).toHaveLength(0);
  });

  it("lists and revokes credentials through the same service", async () => {
    const harness = await createHarness();
    const start = await harness.service.start({ node_id: "node-g", company_pc: true });
    const approval = await harness.service.approve(start.user_code);

    const listed = await harness.service.list(true);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject(approval);
    expect(JSON.stringify(listed)).not.toContain("token_sha256");

    const revoked = await harness.service.revoke(approval.credential_id);
    expect(Object.keys(revoked).sort()).toEqual(["credential_id", "node_id", "revoked_at"]);
    expect(revoked.node_id).toBe("node-g");
    expect(revoked.revoked_at).not.toBeNull();

    const again = await harness.service.revoke(approval.credential_id);
    expect(again.revoked_at).toBe(revoked.revoked_at);
  });

  it("throws typed errors for unknown codes and credentials", async () => {
    const harness = await createHarness();

    await expect(harness.service.poll("unknown-device-code")).rejects.toBeInstanceOf(NodePairingError);
    await expect(harness.service.approve("ZZZZ-ZZZZ")).rejects.toBeInstanceOf(NodePairingError);
    await expect(harness.service.revoke("00000000-0000-4000-8000-000000000000"))
      .rejects.toBeInstanceOf(NodePairingError);
  });
});
