import { describe, expect, it, vi } from "vitest";

import { ReleaseActivationReceiptRepository } from "../src/node/release_activation_receipt_repository.js";
import type { LivePostgresSql } from "../src/runtime/live_db_sql.js";

describe("ReleaseActivationReceiptRepository", () => {
  it("persists one idempotent activation and returns its central generation", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ text: strings.join("?"), values });
        return [{
          manifest_id: "manifest-1",
          activation_generation: 17,
          activated_at: new Date("2026-08-19T09:00:01.000Z"),
          registration_idempotency_key: "registration-key",
        }];
      }),
      { json: vi.fn((value: unknown) => value) },
    ) as unknown as LivePostgresSql;
    const repository = new ReleaseActivationReceiptRepository({
      resolveSql: vi.fn(async () => sql),
      close: vi.fn(async () => undefined),
    });

    await expect(repository.persist({
      nodeId: "node-a",
      manifestId: "manifest-1",
      releaseCohortId: "cohort-1",
      sourceCommit: "commit-1",
      prewarmedAt: "2026-08-19T09:00:00.000Z",
      verification: { host: "verified", runner: "verified", env: "verified", executable: "verified" },
      registrationIdempotencyKey: "registration-key",
    })).resolves.toEqual({
      manifest_id: "manifest-1",
      activation_generation: 17,
      activated_at: "2026-08-19T09:00:01.000Z",
      registration_idempotency_key: "registration-key",
    });

    const normalized = calls[0]!.text.replace(/\s+/g, " ");
    expect(normalized).toContain("INSERT INTO node_release_activation_receipts");
    expect(normalized).toContain("ON CONFLICT (node_id, registration_idempotency_key)");
    expect(normalized).toContain("WHERE node_release_activation_receipts.manifest_id = EXCLUDED.manifest_id");
  });

  it("fails closed when one idempotency key names a different manifest", async () => {
    const sql = Object.assign(
      vi.fn(async () => []),
      { json: vi.fn((value: unknown) => value) },
    ) as unknown as LivePostgresSql;
    const repository = new ReleaseActivationReceiptRepository({
      resolveSql: vi.fn(async () => sql),
      close: vi.fn(async () => undefined),
    });

    await expect(repository.persist({
      nodeId: "node-a",
      manifestId: "manifest-other",
      releaseCohortId: "cohort-1",
      sourceCommit: "commit-1",
      prewarmedAt: "2026-08-19T09:00:00.000Z",
      verification: { host: "verified", runner: "verified", env: "verified", executable: "verified" },
      registrationIdempotencyKey: "registration-key",
    })).rejects.toThrow("release activation idempotency conflict");
  });
});
