import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  validatePublishApproval,
  validatePublishReceipt,
  type PublishEntry,
  type PublishReceipt,
} from "../../scripts/attachment-migration/publish_assets.js";

const cliPath = fileURLToPath(new URL("../../scripts/attachment-migration/publish_assets.ts", import.meta.url));
const manifestHeader = { record_type: "manifest_metadata", dry_run: true, writes_enabled: false };

describe("attachment migration asset publication", () => {
  it("requires apply and the exact approved manifest hash", () => {
    const digest = "a".repeat(64);
    expect(validatePublishApproval(false, undefined, digest)).toBe("dry_run");
    expect(() => validatePublishApproval(true, undefined, digest)).toThrow("APPROVAL_REQUIRED");
    expect(() => validatePublishApproval(true, "b".repeat(64), digest)).toThrow("APPROVAL_REQUIRED");
    expect(validatePublishApproval(true, digest, digest)).toBe("apply");
  });

  it("accepts only a matching E-05 success receipt and its expected original key", () => {
    const identity = planEntry();
    const receipt = copyReceipt(identity);
    expect(validatePublishReceipt(identity, receipt)).toEqual({
      attachmentId: identity.proposed_asset_id,
      storageKey: `session-attachments/originals/${identity.proposed_asset_id}`,
      byteSize: identity.size_bytes,
      checksumSha256: identity.sha256,
    });
    expect(() => validatePublishReceipt(identity, { ...receipt, sha256: "b".repeat(64) }))
      .toThrow("RECEIPT_MISMATCH");
    expect(() => validatePublishReceipt(identity, { ...receipt, storage_key: "other/key" }))
      .toThrow("RECEIPT_MISMATCH");
    expect(() => validatePublishReceipt(identity, { ...receipt, result: "skipped_unconfirmed" }))
      .toThrow("RECEIPT_MISMATCH");
  });

  it("rejects a verified receipt from another endpoint or bucket", () => {
    const identity = planEntry();
    const receipt = copyReceipt(identity);

    expect(() => validatePublishReceipt(identity, { ...receipt, storage_endpoint: "https://other-r2.example.test" }))
      .toThrow("RECEIPT_MISMATCH");
    expect(() => validatePublishReceipt(identity, { ...receipt, storage_bucket: "other-private-attachments" }))
      .toThrow("RECEIPT_MISMATCH");
  });

  it("allows a confirmed missing receipt to publish only a missing alias", () => {
    const identity = planEntry({ status: "confirmed_missing", size_bytes: undefined, sha256: undefined, proposed_asset_id: undefined });
    const receipt: PublishReceipt = {
      identity_key: identity.identity_key,
      attachment_id: identity.identity_key,
      storage_key: "",
      storage_endpoint: null,
      storage_bucket: null,
      byte_size: null,
      sha256: null,
      verified_at: "2026-10-17T00:00:00.000Z",
      result: "skipped_unconfirmed",
    };
    expect(validatePublishReceipt(identity, receipt)).toEqual({
      attachmentId: identity.identity_key,
      storageKey: null,
      byteSize: null,
      checksumSha256: null,
      missing: true,
    });
    expect(() => validatePublishReceipt(planEntry(), receipt)).toThrow("RECEIPT_MISMATCH");
  });

  it("runs dry-run by default without a database URL and rejects unapproved writes", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "attachment-publish-cli-"));
    const manifestPath = path.join(temp, "manifest.jsonl");
    const receiptsPath = path.join(temp, "receipts.jsonl");
    const identity = planEntry();
    await writeFile(manifestPath, `${JSON.stringify(manifestHeader)}\n${JSON.stringify(identity)}\n`);
    await writeFile(receiptsPath, `${JSON.stringify(copyReceipt(identity))}\n`);
    try {
      const dryRun = spawnSync("pnpm", ["exec", "tsx", cliPath, "--manifest", manifestPath, "--receipts", receiptsPath,
        "--limit", "1", "--only", identity.identity_key], {
        cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
        env: { ...process.env, DATABASE_URL: "" },
      });
      expect(dryRun.status, `${dryRun.stdout}\n${dryRun.stderr}`).toBe(0);
      expect(dryRun.stdout).toContain('"writes_enabled":false');
      await expect(readFile(path.join(temp, "published.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const apply = spawnSync("pnpm", ["exec", "tsx", cliPath, "--manifest", manifestPath, "--receipts", receiptsPath, "--apply"], {
        cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
        env: { ...process.env, DATABASE_URL: "" },
      });
      expect(apply.status).toBe(1);
      expect(apply.stderr).toContain("APPROVAL_REQUIRED");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});

function planEntry(overrides: Partial<PublishEntry> = {}): PublishEntry {
  return {
    identity_key: "node-a:/legacy/image.png",
    legacy_node_id: "node-a",
    normalized_path: "/legacy/image.png",
    name: "image.png",
    inferred_mime: "image/png",
    owner: { status: "verified", kind: "user_email", key: "owner@example.test", scope: { type: "card", id: "card-a" }, source: "cards:card-a" },
    status: "verified_source",
    references: [{ source_kind: "card_request", source_table: "cards", source_pk: "card-a", pointer: "/request", session_id: null,
      changed_after_cutoff: false, owner: { status: "verified", kind: "user_email", key: "owner@example.test", scope: { type: "card", id: "card-a" }, source: "cards:card-a" } }],
    source_occurrence_count: 1,
    unreferenced_incoming: false,
    size_bytes: 16,
    sha256: "a".repeat(64),
    proposed_asset_id: "legacy-asset-a",
    proposed_ref_action: "propose_attachment_asset_and_alias",
    storage_endpoint: "https://r2.example.test",
    storage_bucket: "private-attachments",
    ...overrides,
  } as PublishEntry;
}

function copyReceipt(identity: PublishEntry): PublishReceipt {
  return {
    identity_key: identity.identity_key,
    attachment_id: identity.proposed_asset_id ?? identity.identity_key,
    storage_key: `session-attachments/originals/${identity.proposed_asset_id}`,
    storage_endpoint: identity.storage_endpoint,
    storage_bucket: identity.storage_bucket,
    byte_size: identity.size_bytes ?? null,
    sha256: identity.sha256 ?? null,
    verified_at: "2026-10-17T00:00:00.000Z",
    result: "copied",
  };
}
