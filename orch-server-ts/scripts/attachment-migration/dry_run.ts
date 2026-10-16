#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildLegacyAttachmentPlan } from "./build_plan.js";
import {
  INVENTORY_ERROR_CODES as ERROR,
  INVENTORY_PLAN_MARKER,
  INVENTORY_SCHEMA_VERSION,
  inventoryError,
  type FileObservation,
  type InventoryAliasSnapshot,
  type InventoryAssetSnapshot,
  type InventoryNodeCoverage,
  type InventoryPlan,
  type InventoryPlanSummary,
  type InventoryRunBundleMetadata,
  type InventorySessionCoverage,
  type LegacySource,
  type NodeScanSummary,
} from "./inventory_contract.js";

type SourceRecord = LegacySource | InventoryRunBundleMetadata | InventoryAliasSnapshot | InventorySessionCoverage | InventoryAssetSnapshot;
type NodeRecord = FileObservation | NodeScanSummary | InventoryNodeCoverage;

export async function writeDryRun(plan: InventoryPlan, outputDir: string): Promise<InventoryPlanSummary> {
  const manifestPath = path.join(outputDir, "manifest.jsonl");
  const summaryPath = path.join(outputDir, "summary.json");
  const reportPath = path.join(outputDir, "report.md");
  try {
    await mkdir(outputDir, { recursive: true, mode: 0o700 });
    const manifestLines = manifestRecords(plan);
    const manifestHash = await writeLines(manifestPath, manifestLines);
    const report = renderReport(plan, manifestHash);
    const reportHash = await writeText(reportPath, report);
    const onDiskSummary: InventoryPlanSummary = {
      ...plan.summary,
      output_checksums: { "manifest.jsonl": manifestHash, "report.md": reportHash },
      readback_verified: true,
    };
    const summaryText = `${JSON.stringify(onDiskSummary, null, 2)}\n`;
    const expectedSummaryHash = sha256(summaryText);
    await writeText(summaryPath, summaryText);

    const verifiedCount = await verifyManifest(manifestPath, manifestLines.length);
    const savedSummary = JSON.parse(await readFile(summaryPath, "utf8")) as InventoryPlanSummary;
    const checksums = await Promise.all([hashFile(manifestPath), hashFile(summaryPath), hashFile(reportPath)]);
    if (verifiedCount !== manifestLines.length || checksums[0] !== manifestHash || checksums[1] !== expectedSummaryHash || checksums[2] !== reportHash ||
        savedSummary.marker !== INVENTORY_PLAN_MARKER || savedSummary.cutoff !== plan.summary.cutoff) {
      throw new Error("dry-run output readback did not match the written content");
    }
    return {
      ...onDiskSummary,
      output_checksums: { "manifest.jsonl": manifestHash, "summary.json": checksums[1]!, "report.md": reportHash },
      readback_verified: true,
    };
  } catch (error) {
    if (isInventoryError(error)) throw error;
    throw inventoryError(ERROR.output_failed, "could not write and verify dry-run output", error);
  }
}

export async function readDryRunInputs(sourcePath: string, nodePath: string): Promise<{
  metadata: InventoryRunBundleMetadata;
  sources: LegacySource[];
  aliases: InventoryAliasSnapshot[];
  sessionCoverage: InventorySessionCoverage[];
  assets: InventoryAssetSnapshot[];
  observations: FileObservation[];
  nodeCoverage: Array<InventoryNodeCoverage | NodeScanSummary>;
}> {
  const sourceRows = await readJsonl(sourcePath);
  let metadata: InventoryRunBundleMetadata | undefined;
  const sources: LegacySource[] = [];
  const aliases: InventoryAliasSnapshot[] = [];
  const sessionCoverage: InventorySessionCoverage[] = [];
  const verifiedAssets: InventoryAssetSnapshot[] = [];
  for (const value of sourceRows) {
    if (!isRecord(value)) throw inventoryError(ERROR.manifest_mismatch, "source JSONL record must be an object");
    if (value.record_type === "run_metadata") {
      if (metadata !== undefined) throw inventoryError(ERROR.manifest_mismatch, "source JSONL has multiple metadata records");
      metadata = value as unknown as InventoryRunBundleMetadata;
    } else if (value.record_type === "alias") aliases.push(value as unknown as InventoryAliasSnapshot);
    else if (value.record_type === "session_coverage") sessionCoverage.push(value as unknown as InventorySessionCoverage);
    else if (value.record_type === "asset") verifiedAssets.push(value as unknown as InventoryAssetSnapshot);
    else if (value.schema_version === INVENTORY_SCHEMA_VERSION && typeof value.source_kind === "string") sources.push(value as unknown as LegacySource);
    else throw inventoryError(ERROR.manifest_mismatch, "unknown source JSONL record type");
  }
  if (metadata === undefined) throw inventoryError(ERROR.manifest_mismatch, "source JSONL is missing its run_metadata record");

  const observations: FileObservation[] = [];
  const nodeCoverage: Array<InventoryNodeCoverage | NodeScanSummary> = [];
  for (const value of await readJsonl(nodePath)) {
    if (!isRecord(value) || value.schema_version !== INVENTORY_SCHEMA_VERSION) throw inventoryError(ERROR.manifest_mismatch, "node JSONL record is invalid");
    if (value.record_type === "file") observations.push(value as unknown as FileObservation);
    else if (value.record_type === "summary" || value.record_type === "node_coverage") nodeCoverage.push(value as unknown as NodeScanSummary | InventoryNodeCoverage);
    else throw inventoryError(ERROR.manifest_mismatch, "unknown node JSONL record type");
  }
  return { metadata, sources, aliases, sessionCoverage, assets: verifiedAssets, observations, nodeCoverage };
}

async function main(args: string[]): Promise<void> {
  const options = parseArgs(args);
  const input = await readDryRunInputs(options.sources, options.nodes);
  const nodeStage = input.nodeCoverage.filter((row): row is NodeScanSummary => row.record_type === "summary");
  const stages = nodeStage.length === 0 ? input.metadata.stages : {
    ...input.metadata.stages,
    node_scan: {
      started_at: nodeStage.map((row) => row.started_at).sort()[0]!,
      ended_at: nodeStage.map((row) => row.ended_at).sort().at(-1)!,
    },
  };
  const plan = buildLegacyAttachmentPlan({ ...input, metadata: { ...input.metadata, stages }, allowedOrigins: options.allowedOrigins });
  const summary = await writeDryRun(plan, options.output);
  console.log(`${INVENTORY_PLAN_MARKER} ${JSON.stringify(summary)}`);
  process.exitCode = summary.exit_code;
}

function manifestRecords(plan: InventoryPlan): string[] {
  const header = {
    record_type: "manifest_metadata",
    schema_version: INVENTORY_SCHEMA_VERSION,
    scan_id: plan.metadata.scan_id,
    baseline_sha: plan.metadata.baseline_sha,
    cutoff: plan.summary.cutoff,
    observed_at: plan.summary.observed_at,
    stages: plan.stage_timings,
    coverage_complete: plan.coverage_complete,
    dry_run: true,
    writes_enabled: false,
  };
  return [JSON.stringify(header), ...plan.identities.map((item) => JSON.stringify(item)),
    ...plan.existing_assets.map((item) => JSON.stringify({ record_type: "existing_asset", ...item })),
    ...plan.direct_references.map((item) => JSON.stringify({ record_type: "direct_reference", ...item })),
    ...plan.ambiguous_targets.map((item) => JSON.stringify({ record_type: "ambiguous_target", ...item })),
    ...plan.anomalies.map((item) => JSON.stringify({ record_type: "anomaly", ...item }))];
}

async function writeLines(filePath: string, lines: readonly string[]): Promise<string> {
  const handle = await open(filePath, "wx", 0o600);
  const hash = createHash("sha256");
  try {
    for (const line of lines) {
      const output = `${line}\n`;
      await handle.writeFile(output, "utf8");
      hash.update(output, "utf8");
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function writeText(filePath: string, value: string): Promise<string> {
  const handle = await open(filePath, "wx", 0o600);
  try { await handle.writeFile(value, "utf8"); } finally { await handle.close(); }
  return sha256(value);
}

async function verifyManifest(filePath: string, expectedLines: number): Promise<number> {
  const lines = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  let count = 0;
  for await (const line of lines) {
    if (!line) throw new Error("manifest contains an empty line");
    JSON.parse(line);
    count += 1;
  }
  if (count !== expectedLines) throw new Error("manifest record count changed during readback");
  return count;
}

function renderReport(plan: InventoryPlan, manifestHash: string): string {
  const summary = plan.summary;
  const lines = [
    `# ${INVENTORY_PLAN_MARKER}`,
    "",
    `- scan_id: ${summary.scan_id}`,
    `- baseline_sha: ${summary.baseline_sha}`,
    `- cutoff: ${summary.cutoff}`,
    `- coverage_complete: ${summary.coverage_complete}`,
    `- exit_code: ${summary.exit_code}`,
    "- dry_run: true",
    "- 쓰기 활성화: 아니오",
    "- db_mutation_count: 0",
    "- r2_put_count: 0",
    `- manifest sha256: ${manifestHash}`,
    "",
    "## 집계",
    "",
    `- reference_occurrences: ${summary.reference_occurrences}`,
    `- distinct_legacy_identities: ${summary.distinct_legacy_identities}`,
    `- discovered_files: ${summary.discovered_files}`,
    `- referenced_files / unreferenced_files: ${summary.referenced_files} / ${summary.unreferenced_files}`,
    `- verified_source_count / verified_source_bytes: ${summary.verified_source_count} / ${summary.verified_source_bytes}`,
    `- known_size_total / unknown_size_count: ${summary.known_size_total} / ${summary.unknown_size_count}`,
    `- proposed_assets / aliases: ${summary.proposed_assets} / ${summary.proposed_aliases}`,
    `- preservation_target_count / preservation_target_bytes: ${summary.preservation_target_count} / ${summary.preservation_target_bytes}`,
    `- preservation_target_unknown_count: ${summary.preservation_target_unknown_count}`,
    `- ref_connectable_message_count / ref_connectable_card_count: ${summary.ref_connectable_message_count} / ${summary.ref_connectable_card_count}`,
    `- owner_null_proposal_count: ${summary.owner_null_proposal_count}`,
    `- expected_copy_bytes / unknown_size_count: ${summary.expected_copy_bytes} / ${summary.expected_copy_unknown_count}`,
    `- existing_asset_count / existing_board_asset_count: ${summary.existing_asset_count} / ${summary.existing_board_asset_count}`,
    `- duplicate_byte_groups / duplicate_byte_total_bytes: ${summary.duplicate_byte_groups} / ${summary.duplicate_byte_total_bytes}`,
    "",
    "## 노드별 상태",
    "",
    ...summary.nodes.map((node) => `- ${node.node_id}: ${node.status}, files=${node.file_count}, bytes=${node.bytes}, hash_coverage=${node.hash_coverage}, complete=${node.coverage_complete}`),
    "",
    "## 미확인과 계획 오류",
    "",
    ...(summary.unconfirmed.length ? summary.unconfirmed.map((item) => `- ${item.subject}: ${item.status}${item.reason ? ` (${item.reason})` : ""}`) : ["- 없음"]),
    ...summary.planning_errors.map((error) => `- planning_error: ${error}`),
    "",
    "## 이상치",
    "",
    ...(plan.anomalies.length ? plan.anomalies.map((item) => `- ${item.code}: ${item.subject} — ${item.message}`) : ["- 없음"]),
    "",
  ];
  return lines.join("\n");
}

async function readJsonl(filePath: string): Promise<unknown[]> {
  const lines = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  const values: unknown[] = [];
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try { values.push(JSON.parse(line)); }
    catch (error) { throw inventoryError(ERROR.manifest_mismatch, `invalid JSONL at ${filePath}:${lineNumber}`, error); }
  }
  return values;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function parseArgs(args: string[]): { sources: string; nodes: string; output: string; allowedOrigins: string[] } {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !flag.startsWith("--") || !value || value.startsWith("--") || result[flag] !== undefined) throw new TypeError("usage: dry_run.ts --sources <JSONL> --nodes <JSONL> --output <directory>");
    result[flag] = value;
  }
  const sources = result["--sources"];
  const nodes = result["--nodes"];
  const output = result["--output"];
  const allowedOriginsJson = result["--allowed-origins"];
  if (!sources || !nodes || !output || allowedOriginsJson === undefined || Object.keys(result).length !== 4) {
    throw new TypeError("usage: dry_run.ts --sources <JSONL> --nodes <JSONL> --output <directory> --allowed-origins <JSON array>");
  }
  let allowedOrigins: unknown;
  try { allowedOrigins = JSON.parse(allowedOriginsJson); }
  catch { throw new TypeError("--allowed-origins must be a JSON array of origins"); }
  if (!Array.isArray(allowedOrigins) || allowedOrigins.some((origin) => typeof origin !== "string")) {
    throw new TypeError("--allowed-origins must be a JSON array of origins");
  }
  return { sources, nodes, output, allowedOrigins };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function isInventoryError(value: unknown): value is Error & { code: string } { return value instanceof Error && "code" in value; }

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const code = isInventoryError(error) ? error.code : "INVENTORY_MANIFEST_MISMATCH";
    console.error(`${code}: ${error instanceof Error ? error.message : "dry-run failed"}`);
    process.exitCode = 1;
  });
}
