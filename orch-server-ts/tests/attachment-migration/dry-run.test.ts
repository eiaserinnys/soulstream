import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildLegacyAttachmentPlan } from "../../scripts/attachment-migration/build_plan.js";
import { readDryRunInputs, writeDryRun } from "../../scripts/attachment-migration/dry_run.js";
import {
  FILE_OBSERVATION_STATUS,
  INVENTORY_SCHEMA_VERSION,
  type FileObservation,
  type InventoryNodeCoverage,
  type InventoryRunBundleMetadata,
  type LegacySource,
} from "../../scripts/attachment-migration/inventory_contract.js";

const CUTOFF = "2026-10-17T00:00:00.000Z";
const cliPath = fileURLToPath(new URL("../../scripts/attachment-migration/dry_run.ts", import.meta.url));

describe("attachment migration dry-run output", () => {
  it("writes readable local JSONL, summary, and Markdown with checksum verification and no external writes", async () => {
    const source = legacySource();
    const plan = buildLegacyAttachmentPlan({
      sources: [source],
      observations: [observation(source)],
      assets: [],
      aliases: [],
      nodeCoverage: [nodeCoverage()],
      metadata: metadata(),
    });
    const temp = await mkdtemp(path.join(os.tmpdir(), "attachment-dry-run-"));
    const outputDir = path.join(temp, "output");

    try {
      const summary = await writeDryRun(plan, outputDir);
      const manifestText = await readFile(path.join(outputDir, "manifest.jsonl"), "utf8");
      const summaryJson = JSON.parse(await readFile(path.join(outputDir, "summary.json"), "utf8"));
      const report = await readFile(path.join(outputDir, "report.md"), "utf8");
      const records = manifestText.trimEnd().split("\n").map((line) => JSON.parse(line));

      expect(summary.marker).toBe("ATTACHMENT_MIGRATION_DRY_RUN");
      expect(summary).toMatchObject({ dry_run: true, writes_enabled: false, db_mutation_count: 0, r2_put_count: 0, readback_verified: true });
      expect(summary.output_checksums).toMatchObject({
        "manifest.jsonl": expect.stringMatching(/^[0-9a-f]{64}$/),
        "summary.json": expect.stringMatching(/^[0-9a-f]{64}$/),
        "report.md": expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(summaryJson).toMatchObject({ marker: summary.marker, cutoff: CUTOFF, coverage_complete: true });
      expect(records[0]).toMatchObject({ record_type: "manifest_metadata", cutoff: CUTOFF, baseline_sha: "88cab796" });
      expect(records[1]).toMatchObject({ legacy_node_id: "node-a", normalized_path: "image.png", sha256: "a".repeat(64) });
      expect(report).toContain("ATTACHMENT_MIGRATION_DRY_RUN");
      expect(report).toContain("쓰기 활성화: 아니오");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("runs the JSONL CLI, reports its marker, and returns exit 2 for incomplete node coverage", async () => {
    const source = legacySource();
    const bundle = metadata();
    bundle.expected_node_ids = ["node-a", "node-missing"];
    const temp = await mkdtemp(path.join(os.tmpdir(), "attachment-dry-run-cli-"));
    const sourcesPath = path.join(temp, "sources.jsonl");
    const nodesPath = path.join(temp, "nodes.jsonl");
    const outputDir = path.join(temp, "output");
    await writeFile(sourcesPath, [bundle, source].map((row) => JSON.stringify(row)).join("\n") + "\n");
    await writeFile(nodesPath, [observation(source), nodeCoverage()].map((row) => JSON.stringify(row)).join("\n") + "\n");

    try {
      const result = spawnSync("pnpm", ["exec", "tsx", cliPath, "--sources", sourcesPath, "--nodes", nodesPath, "--output", outputDir], {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(result.status).toBe(2);
      expect(result.stdout).toContain("ATTACHMENT_MIGRATION_DRY_RUN");
      const summary = JSON.parse(await readFile(path.join(outputDir, "summary.json"), "utf8"));
      expect(summary).toMatchObject({ coverage_complete: false, exit_code: 2, db_mutation_count: 0, r2_put_count: 0, readback_verified: true });
      expect(summary.unconfirmed).toEqual(expect.arrayContaining([expect.objectContaining({ subject: "node-missing", status: "not_reported" })]));
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("lets the planner extract file_assets once from the full relational source row", async () => {
    const fileAsset: LegacySource = {
      ...legacySource(),
      source_kind: "existing_asset",
      source_table: "file_assets",
      source_pk: "asset-a",
      source_pointer: "/",
      updated_at: CUTOFF,
      data: {
        storage_purpose: "attachment",
        storage_key: "attachments/asset-a",
        storage_endpoint: "https://storage.example.test",
        storage_bucket: "attachments",
        upload_status: "committed",
        original_name: "image.png",
        mime_type: "image/png",
        byte_size: 5,
        checksum_sha256: "a".repeat(64),
      },
    };
    const temp = await mkdtemp(path.join(os.tmpdir(), "attachment-dry-run-assets-"));
    const sourcesPath = path.join(temp, "sources.jsonl");
    const nodesPath = path.join(temp, "nodes.jsonl");
    await writeFile(sourcesPath, [metadata(), fileAsset].map((row) => JSON.stringify(row)).join("\n") + "\n");
    await writeFile(nodesPath, `${JSON.stringify({
      record_type: "summary",
      schema_version: INVENTORY_SCHEMA_VERSION,
      node_id: "node-a",
      cutoff: CUTOFF,
      started_at: CUTOFF,
      ended_at: CUTOFF,
      coverage_complete: true,
      file_count: 0,
      bytes_hashed: 0,
      hashes_completed: 0,
      after_cutoff_count: 0,
      status_counts: {},
    })}\n`);

    try {
      const input = await readDryRunInputs(sourcesPath, nodesPath);
      const plan = buildLegacyAttachmentPlan(input);
      expect(input.assets).toEqual([]);
      expect(plan.summary.existing_asset_count).toBe(1);
      expect(plan.summary.planning_errors).not.toContain("INVENTORY_MANIFEST_MISMATCH");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});

function metadata(): InventoryRunBundleMetadata {
  return {
    record_type: "run_metadata",
    schema_version: INVENTORY_SCHEMA_VERSION,
    scan_id: "scan-245",
    baseline_sha: "88cab796",
    cutoff: CUTOFF,
    expected_node_ids: ["node-a"],
    relational_coverage_complete: true,
    event_session_ids: [],
    alias_snapshot_complete: true,
    stages: {
      relational: { started_at: CUTOFF, ended_at: CUTOFF },
      events: { started_at: CUTOFF, ended_at: CUTOFF },
      node_scan: { started_at: CUTOFF, ended_at: CUTOFF },
    },
  };
}

function legacySource(): LegacySource {
  return {
    schema_version: INVENTORY_SCHEMA_VERSION,
    source_kind: "message",
    source_table: "events",
    source_pk: "22",
    source_pointer: "/payload",
    row_sha256: "b".repeat(64),
    created_at: CUTOFF,
    changed_after_cutoff: false,
    session_id: "session-a",
    data: {
      source_node_id: "node-a",
      event_id: 22,
      event_type: "user_message",
      attachment_candidates: [{ pointer: "/payload/attachments/0", kind: "input_path", value: "image.png" }],
      owner_kind: "agent_session",
      owner_key: "session-a",
    },
  };
}

function observation(source: LegacySource): FileObservation {
  return {
    record_type: "file",
    schema_version: INVENTORY_SCHEMA_VERSION,
    node_id: "node-a",
    status: FILE_OBSERVATION_STATUS.observed,
    known_source_paths: ["image.png"],
    incoming_relative_path: "image.png",
    physical_path: "/srv/incoming/image.png",
    source_refs: [{
      source_kind: source.source_kind,
      source_table: source.source_table,
      source_pk: source.source_pk,
      source_pointer: "/payload/attachments/0",
      session_id: source.session_id,
    }],
    size_bytes: 5,
    bytes_read: 5,
    mtime_ms: new Date(CUTOFF).getTime(),
    mtime: CUTOFF,
    sha256: "a".repeat(64),
    after_cutoff: false,
    eligible_candidate: true,
    coverage_complete: true,
  };
}

function nodeCoverage(): InventoryNodeCoverage {
  return {
    record_type: "node_coverage",
    schema_version: INVENTORY_SCHEMA_VERSION,
    node_id: "node-a",
    status: "scanned",
    coverage_complete: true,
    observed_at: CUTOFF,
  };
}
