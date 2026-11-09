import { describe, expect, it, vi } from "vitest";

import { NodeCredentialStore } from "../src/node_credentials/index.js";
import {
  InMemoryNodeCredentialRepository,
  createInitializedStore,
  seededRow,
} from "./node-credentials-test-support.js";

describe("NodeCredentialStore", () => {
  it("loads active credentials at startup and resolves tokens to principals", async () => {
    const repository = new InMemoryNodeCredentialRepository();
    repository.rows.push(seededRow("cred-1", "node-a", true, "token-a"));
    const store = new NodeCredentialStore({ repository });

    expect(store.resolve("token-a")).toBeNull();

    await expect(store.initialize()).resolves.toEqual({ ok: true });
    expect(store.resolve("token-a")).toEqual({
      credential_id: "cred-1",
      node_id: "node-a",
      company_pc: true,
    });
    expect(store.resolve("token-b")).toBeNull();
    expect(store.resolve("")).toBeNull();
  });

  it("keeps the resolver closed when the startup read fails", async () => {
    const repository = new InMemoryNodeCredentialRepository();
    repository.rows.push(seededRow("cred-1", "node-a", false, "token-a"));
    repository.failLoad = true;
    const store = new NodeCredentialStore({ repository });

    const result = await store.initialize();

    expect(result.ok).toBe(false);
    expect(store.resolve("token-a")).toBeNull();
  });

  it("adds a newly created credential to the in-memory map and stores only its hash", async () => {
    const { repository, store } = await createInitializedStore();

    const created = await store.createCredential({ node_id: "node-b", company_pc: false });

    expect(created.token.length).toBeGreaterThanOrEqual(43);
    expect(store.resolve(created.token)).toEqual({
      credential_id: created.credential.credential_id,
      node_id: "node-b",
      company_pc: false,
    });
    expect(created.credential).not.toHaveProperty("token_sha256");
    expect(JSON.stringify(created.credential)).not.toContain(created.token);
    expect(repository.rows).toHaveLength(1);
    expect(repository.rows[0]!.token_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(repository.rows[0]!.token_sha256).not.toBe(created.token);
  });

  it("revokes a credential, notifies listeners once, and stays idempotent", async () => {
    const { store } = await createInitializedStore();
    const created = await store.createCredential({ node_id: "node-c", company_pc: false });
    const revoked = vi.fn();
    const unsubscribe = store.onRevoked(revoked);

    const first = await store.revokeCredential(created.credential.credential_id);

    expect(first.outcome).toBe("revoked");
    expect(first.credential?.revoked_at).not.toBeNull();
    expect(store.resolve(created.token)).toBeNull();
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(revoked).toHaveBeenCalledWith({
      credential_id: created.credential.credential_id,
      node_id: "node-c",
      company_pc: false,
    });

    const second = await store.revokeCredential(created.credential.credential_id);

    expect(second.outcome).toBe("already_revoked");
    expect(second.credential?.revoked_at).toBe(first.credential?.revoked_at);
    expect(revoked).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it("returns not_found for an unknown credential and lists records without hashes", async () => {
    const { store } = await createInitializedStore();
    const created = await store.createCredential({ node_id: "node-d", company_pc: true });

    expect((await store.revokeCredential("00000000-0000-4000-8000-000000000000")).outcome)
      .toBe("not_found");

    const active = await store.listCredentials(false);
    expect(active).toHaveLength(1);
    expect(active[0]).toEqual(created.credential);
    for (const record of await store.listCredentials(true)) {
      expect(record).not.toHaveProperty("token_sha256");
    }

    await store.revokeCredential(created.credential.credential_id);
    expect(await store.listCredentials(false)).toHaveLength(0);
    expect(await store.listCredentials(true)).toHaveLength(1);
  });

  it("knows whether a node has an active credential", async () => {
    const { store } = await createInitializedStore();

    expect(store.hasActiveNode("node-e")).toBe(false);
    const created = await store.createCredential({ node_id: "node-e", company_pc: false });
    expect(store.hasActiveNode("node-e")).toBe(true);

    await store.revokeCredential(created.credential.credential_id);
    expect(store.hasActiveNode("node-e")).toBe(false);
  });
});
