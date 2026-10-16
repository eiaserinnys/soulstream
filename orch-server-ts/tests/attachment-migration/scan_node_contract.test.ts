import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildLegacyAttachmentPlan } from "../../scripts/attachment-migration/build_plan.js";
import {
  FILE_OBSERVATION_STATUS,
  INVENTORY_PLAN_STATUS,
  INVENTORY_SCHEMA_VERSION,
  NODE_INVENTORY_RECORDED,
  type NodeScanOutputRecord,
} from "../../scripts/attachment-migration/inventory_contract.js";

const scannerPath = fileURLToPath(new URL("../../scripts/attachment-migration/scan_node.mjs", import.meta.url));

describe("node attachment inventory CLI contract", () => {
  it.each(["blocked", "."])("keeps an existing file under unreadable directory %s unconfirmed from CLI through planner", async (directory) => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "attachment-scan-denied-"));
    const incoming = path.join(temp, "incoming");
    const blocked = path.join(incoming, directory);
    const present = path.join(blocked, "present.png");
    const output = path.join(temp, "inventory.jsonl");
    const cutoff = "2027-01-01T00:00:00.000Z";
    await mkdir(blocked, { recursive: true });
    await writeFile(present, "present");
    await writeFile(path.join(temp, "sources.json"), "[]");
    await writeFile(path.join(temp, "roots.json"), JSON.stringify([temp]));
    await chmod(blocked, 0o000);
    try {
      const result = spawnSync(process.execPath, [
        scannerPath, "--node-id", "node-a", "--incoming-root", incoming,
        "--sources", path.join(temp, "sources.json"), "--allowed-roots", path.join(temp, "roots.json"),
        "--cutoff", cutoff, "--output", output,
      ], { encoding: "utf8" });
      expect(result.status).toBe(2);
      const records = (await readFile(output, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line) as NodeScanOutputRecord);
      const plan = buildLegacyAttachmentPlan({
        sources: [{
          schema_version: INVENTORY_SCHEMA_VERSION, source_kind: "card_request", source_table: "cards",
          source_pk: "card-a", source_pointer: "/", row_sha256: "a".repeat(64), created_at: cutoff,
          changed_after_cutoff: false, card_id: "card-a", data: { attachments: [{ nodeId: "node-a", path: present }] },
        }],
        observations: records.filter((record) => record.record_type === "file"),
        nodeCoverage: records.filter((record) => record.record_type === "summary"),
        assets: [], aliases: [],
        metadata: {
          record_type: "run_metadata", schema_version: INVENTORY_SCHEMA_VERSION, scan_id: "denied-census",
          baseline_sha: "1fe5a517", cutoff, expected_node_ids: ["node-a"], event_session_ids: [],
          relational_coverage_complete: true, alias_snapshot_complete: true,
          stages: { relational: { started_at: cutoff, ended_at: cutoff }, events: { started_at: cutoff, ended_at: cutoff }, node_scan: { started_at: cutoff, ended_at: cutoff } },
        },
      });
      expect(plan.identities).toHaveLength(1);
      expect(plan.identities[0]?.status).toBe(INVENTORY_PLAN_STATUS.unconfirmed_node);
      expect(plan.coverage_complete).toBe(false);
      expect(plan.summary.exit_code).toBe(2);
      expect(records.find((record) => record.record_type === "summary")).toMatchObject({ incoming_census_complete: false });
      expect(records.find((record) => record.record_type === "summary")).not.toHaveProperty("incoming_root");
    } finally {
      await chmod(blocked, 0o700);
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("streams JSONL records using the shared inventory contract", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "attachment-scan-contract-"));
    const allowed = path.join(temp, "allowed");
    const incoming = path.join(allowed, "incoming");
    const output = path.join(temp, "inventory.jsonl");
    await mkdir(incoming, { recursive: true });
    await writeFile(path.join(incoming, "file.bin"), "hello");
    await writeFile(path.join(temp, "sources.json"), "[]");
    await writeFile(path.join(temp, "roots.json"), JSON.stringify([allowed]));

    try {
      const result = spawnSync(process.execPath, [
        scannerPath,
        "--node-id", "node-a",
        "--incoming-root", incoming,
        "--sources", path.join(temp, "sources.json"),
        "--allowed-roots", path.join(temp, "roots.json"),
        "--cutoff", "2027-01-01T00:00:00.000Z",
        "--output", output,
      ], { encoding: "utf8" });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(NODE_INVENTORY_RECORDED);
      const records = (await readFile(output, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as NodeScanOutputRecord);
      expect(records).toHaveLength(2);
      const file = records.find((record) => record.record_type === "file");
      const summary = records.find((record) => record.record_type === "summary");
      if (!file || file.record_type !== "file" || !summary || summary.record_type !== "summary") {
        throw new Error("scanner output must contain one file record and one summary record");
      }
      expect(file).toMatchObject({
        record_type: "file",
        schema_version: INVENTORY_SCHEMA_VERSION,
        node_id: "node-a",
        status: FILE_OBSERVATION_STATUS.observed,
        size_bytes: 5,
        bytes_read: 5,
        eligible_candidate: true,
        coverage_complete: true,
      });
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(summary).toMatchObject({
        record_type: "summary",
        schema_version: INVENTORY_SCHEMA_VERSION,
        node_id: "node-a",
        incoming_root: incoming,
        incoming_census_complete: true,
        cutoff: "2027-01-01T00:00:00.000Z",
        coverage_complete: true,
        file_count: 1,
        bytes_hashed: 5,
        hashes_completed: 1,
      });
      expect(summary.started_at).toMatch(/^\d{4}-\d\d-\d\dT/);
      expect(summary.ended_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("marks incoming census complete when one explicitly listed source is absent", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "attachment-scan-explicit-missing-"));
    const allowed = path.join(temp, "allowed");
    const incoming = path.join(allowed, "incoming");
    const missing = path.join(allowed, "archived", "missing.png");
    const output = path.join(temp, "inventory.jsonl");
    await mkdir(incoming, { recursive: true });
    await writeFile(path.join(incoming, "present.png"), "image");
    await writeFile(path.join(temp, "sources.json"), JSON.stringify([{
      node_id: "node-a",
      path: missing,
      source_ref: { source_kind: "card_request", source_table: "cards", source_pk: "card-a", source_pointer: "/attachments/0/path" },
    }]));
    await writeFile(path.join(temp, "roots.json"), JSON.stringify([allowed]));

    try {
      const result = spawnSync(process.execPath, [
        scannerPath,
        "--node-id", "node-a",
        "--incoming-root", incoming,
        "--sources", path.join(temp, "sources.json"),
        "--allowed-roots", path.join(temp, "roots.json"),
        "--cutoff", "2027-01-01T00:00:00.000Z",
        "--output", output,
      ], { encoding: "utf8" });

      expect(result.status).toBe(2);
      const records = (await readFile(output, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line) as NodeScanOutputRecord);
      const summary = records.find((record) => record.record_type === "summary");
      const missingFile = records.find((record) => record.record_type === "file" && record.status === FILE_OBSERVATION_STATUS.source_absent);
      expect(summary).toMatchObject({
        record_type: "summary",
        coverage_complete: false,
        incoming_root: incoming,
        incoming_census_complete: true,
        status_counts: { observed: 1, source_absent: 1 },
      });
      expect(missingFile).toMatchObject({ status: FILE_OBSERVATION_STATUS.source_absent, physical_path: missing, coverage_complete: false });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("leaves the incoming census incomplete when the root is unconfirmed and one explicit source is absent", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "attachment-scan-missing-root-and-source-"));
    const allowed = path.join(temp, "allowed");
    const incoming = path.join(allowed, "incoming");
    const missing = path.join(allowed, "archived", "missing.png");
    const output = path.join(temp, "inventory.jsonl");
    await mkdir(allowed, { recursive: true });
    await writeFile(path.join(temp, "sources.json"), JSON.stringify([{
      node_id: "node-a",
      path: missing,
      source_ref: { source_kind: "card_request", source_table: "cards", source_pk: "card-a", source_pointer: "/attachments/0/path" },
    }]));
    await writeFile(path.join(temp, "roots.json"), JSON.stringify([allowed]));

    try {
      const result = spawnSync(process.execPath, [
        scannerPath,
        "--node-id", "node-a",
        "--incoming-root", incoming,
        "--sources", path.join(temp, "sources.json"),
        "--allowed-roots", path.join(temp, "roots.json"),
        "--cutoff", "2027-01-01T00:00:00.000Z",
        "--output", output,
      ], { encoding: "utf8" });

      expect(result.status).toBe(2);
      const records = (await readFile(output, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line) as NodeScanOutputRecord);
      const rootError = records.find((record) => record.record_type === "file" && record.status === FILE_OBSERVATION_STATUS.root_unconfirmed);
      const missingFile = records.find((record) => record.record_type === "file" && record.status === FILE_OBSERVATION_STATUS.source_absent);
      const summary = records.find((record) => record.record_type === "summary");
      expect(rootError).toMatchObject({ status: FILE_OBSERVATION_STATUS.root_unconfirmed, coverage_complete: false });
      expect(rootError).not.toHaveProperty("physical_path");
      expect(missingFile).toMatchObject({ status: FILE_OBSERVATION_STATUS.source_absent, physical_path: missing, coverage_complete: false });
      expect(summary).toMatchObject({
        record_type: "summary",
        coverage_complete: false,
        incoming_census_complete: false,
        status_counts: { root_unconfirmed: 1, source_absent: 1 },
      });
      expect(summary).not.toHaveProperty("incoming_root");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("rejects a calendar-invalid cutoff before creating output", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "attachment-scan-invalid-cutoff-"));
    const allowed = path.join(temp, "allowed");
    const incoming = path.join(allowed, "incoming");
    const output = path.join(temp, "inventory.jsonl");
    await mkdir(incoming, { recursive: true });
    await writeFile(path.join(temp, "sources.json"), "[]");
    await writeFile(path.join(temp, "roots.json"), JSON.stringify([allowed]));

    try {
      const result = spawnSync(process.execPath, [
        scannerPath,
        "--node-id", "node-a",
        "--incoming-root", incoming,
        "--sources", path.join(temp, "sources.json"),
        "--allowed-roots", path.join(temp, "roots.json"),
        "--cutoff", "2026-02-30T00:00:00.000Z",
        "--output", output,
      ], { encoding: "utf8" });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("cutoff must be a valid UTC ISO timestamp");
      await expect(readFile(output, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("keeps output outside the canonical incoming root when the root is a symlink", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "attachment-scan-output-path-"));
    const allowed = path.join(temp, "allowed");
    const canonicalIncoming = path.join(allowed, "incoming");
    const incomingAlias = path.join(temp, "incoming-link");
    const output = path.join(canonicalIncoming, "inventory.jsonl");
    await mkdir(canonicalIncoming, { recursive: true });
    await symlink(canonicalIncoming, incomingAlias, "dir");
    await writeFile(path.join(temp, "sources.json"), "[]");
    await writeFile(path.join(temp, "roots.json"), JSON.stringify([allowed]));

    try {
      const result = spawnSync(process.execPath, [
        scannerPath,
        "--node-id", "node-a",
        "--incoming-root", incomingAlias,
        "--sources", path.join(temp, "sources.json"),
        "--allowed-roots", path.join(temp, "roots.json"),
        "--cutoff", "2027-01-01T00:00:00.000Z",
        "--output", output,
      ], { encoding: "utf8" });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("--output must be outside --incoming-root");
      await expect(readFile(output, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
