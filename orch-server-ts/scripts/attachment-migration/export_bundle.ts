import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import {
  INVENTORY_ERROR_CODES as ERROR,
  INVENTORY_EVENT_PROGRESS_STATE,
  INVENTORY_EXPORT_PART_KIND,
  INVENTORY_SCHEMA_VERSION,
  inventoryError,
  parseInventoryCutoff,
  type InventoryAliasSnapshot,
  type InventoryAssetSnapshot,
  type InventoryExportPart,
  type InventoryRunBundleMetadata,
  type InventorySessionCoverage,
  type InventorySessionList,
  type LegacySource,
} from "./inventory_contract.js";

type Options = Record<string, string>;

export async function exportBundle(options: Options): Promise<void> {
  assertAllowedOptions(options, ["--parts", "--expected-nodes", "--baseline-sha", "--output"]);
  const partsOption = requiredOption(options, "--parts");
  const expectedNodesOption = requiredOption(options, "--expected-nodes");
  const baselineSha = requiredOption(options, "--baseline-sha");
  const output = requiredOption(options, "--output");
  const partsInput = parseJsonArray(partsOption, "--parts");
  const expectedNodeIds = parseJsonArray(expectedNodesOption, "--expected-nodes");
  if (partsInput.some((item) => typeof item !== "string") || expectedNodeIds.some((item) => typeof item !== "string" || !item)) {
    throw new TypeError("--parts and --expected-nodes must contain string values");
  }
  if (partsInput.length === 0) throw new TypeError("--parts must include at least one source part");
  if (!/^[0-9a-f]{7,40}$/i.test(baselineSha)) throw new TypeError("--baseline-sha must be a git SHA");
  const partPaths = await uniquePartPaths(partsInput as string[]);
  const parsedParts = await Promise.all(partPaths.map((filePath) => readPart(filePath)));
  const sessionListParts = parsedParts.filter((item) => item.sessionList !== undefined);
  const relationalParts = parsedParts.filter((item) => item.part?.part_kind === INVENTORY_EXPORT_PART_KIND.relational);
  const eventParts = parsedParts.filter((item) => item.part?.part_kind === INVENTORY_EXPORT_PART_KIND.events);
  const sessionList = sessionListParts[0]?.sessionList;
  const cutoff = parseInventoryCutoff(sessionList?.cutoff ?? parsedParts[0]?.part?.cutoff ?? new Date().toISOString());
  const cutoffMismatch = parsedParts.some((item) => item.part?.cutoff !== undefined && item.part.cutoff !== cutoff) ||
    sessionListParts.some((item) => item.sessionList?.cutoff !== cutoff);
  const eventSessions = sessionListParts.flatMap((item) => item.sessionList?.session_ids ?? []);
  const allEventSessionIds = new Set<string>(eventSessions);
  const selectedSessionIds = new Set(eventSessions);
  const occurrences = new Map<string, { rows: InventorySessionCoverage[]; partCount: number }>();
  for (const item of eventParts) {
    for (const sessionId of item.part?.session_ids ?? []) {
      allEventSessionIds.add(sessionId);
      const entry = occurrences.get(sessionId) ?? { rows: [], partCount: 0 };
      entry.partCount += 1;
      occurrences.set(sessionId, entry);
    }
    for (const row of item.sessionCoverage) {
      const entry = occurrences.get(row.session_id) ?? { rows: [], partCount: 0 };
      if (!entry.rows.includes(row)) entry.rows.push(row);
      occurrences.set(row.session_id, entry);
      allEventSessionIds.add(row.session_id);
    }
  }
  const coverageRows: InventorySessionCoverage[] = [];
  let eventCoverageComplete = sessionList !== undefined && sessionListParts.length === 1 && eventParts.length > 0 &&
    eventParts.every((item) => item.part?.coverage_complete === true);
  for (const sessionId of [...allEventSessionIds].sort()) {
    const entry = occurrences.get(sessionId);
    const repeated = (entry?.partCount ?? 0) > 1;
    const row = entry?.rows.sort((left, right) => right.observed_at.localeCompare(left.observed_at))[0];
    const issue = cutoffMismatch ? "cutoff_mismatch"
      : repeated ? "overlapping_event_parts"
        : !selectedSessionIds.has(sessionId) ? "session_not_in_selection"
          : !row ? "missing_event_coverage"
            : entry?.partCount !== 1 ? "session_not_declared_in_event_part"
              : undefined;
    const complete = issue === undefined && row?.coverage_complete === true && (entry?.partCount ?? 0) === 1;
    if (!complete) eventCoverageComplete = false;
    coverageRows.push({
      record_type: "session_coverage", schema_version: INVENTORY_SCHEMA_VERSION, session_id: sessionId,
      state: complete ? row!.state : INVENTORY_EVENT_PROGRESS_STATE.incomplete,
      cursor: row?.cursor ?? { sessionId, eventId: 0 },
      coverage_complete: complete,
      started_at: row?.started_at ?? now(), observed_at: now(), ended_at: row?.ended_at ?? now(),
      ...(complete ? row?.error_code === undefined ? {} : { error_code: row.error_code } : { error_code: ERROR.coverage_incomplete, coverage_issue: issue }),
    });
  }
  for (const sessionId of eventSessions) if (!occurrences.has(sessionId)) eventCoverageComplete = false;
  if (cutoffMismatch || relationalParts.length !== 1 || sessionListParts.length !== 1 ||
      eventParts.length === 0 || relationalParts[0]?.part?.coverage_complete !== true ||
      relationalParts[0]?.part?.alias_snapshot_complete !== true) eventCoverageComplete = false;

  const stages: InventoryRunBundleMetadata["stages"] = {};
  if (relationalParts[0]?.part) stages.relational = { started_at: relationalParts[0].part.started_at, ended_at: relationalParts[0].part.ended_at };
  if (eventParts.length > 0) stages.events = {
    started_at: eventParts.map((item) => item.part!.started_at).sort()[0]!,
    ended_at: eventParts.map((item) => item.part!.ended_at).sort().at(-1)!,
  };
  const metadata: InventoryRunBundleMetadata & { coverage_complete: boolean } = {
    record_type: "run_metadata", schema_version: INVENTORY_SCHEMA_VERSION, scan_id: randomUUID(),
    baseline_sha: baselineSha, cutoff,
    expected_node_ids: [...new Set(expectedNodeIds as string[])].sort(),
    relational_coverage_complete: relationalParts.length === 1 && relationalParts[0]?.part?.coverage_complete === true && !cutoffMismatch,
    event_session_ids: [...allEventSessionIds].sort(),
    alias_snapshot_complete: relationalParts.length === 1 && relationalParts[0]?.part?.alias_snapshot_complete === true && !cutoffMismatch,
    coverage_complete: eventCoverageComplete, stages,
  };
  const writer = await openNewOutput(output);
  try {
    await writer.jsonl(metadata);
    const emittedSources = new Set<string>();
    for (const item of parsedParts) {
      for (const source of item.sources) {
        const key = JSON.stringify(source);
        if (emittedSources.has(key)) continue;
        emittedSources.add(key);
        await writer.jsonl(source);
      }
      for (const alias of item.aliases) await writer.jsonl(alias);
      for (const asset of item.assets) await writer.jsonl(asset);
    }
    for (const coverage of coverageRows) await writer.jsonl(coverage);
  } finally {
    await writer.close();
  }
  await reportReadback(output, "INVENTORY_BUNDLE_ASSEMBLED");
}

type ParsedPart = {
  part?: InventoryExportPart;
  sessionList?: InventorySessionList;
  sources: LegacySource[];
  aliases: InventoryAliasSnapshot[];
  assets: InventoryAssetSnapshot[];
  sessionCoverage: InventorySessionCoverage[];
};

async function readPart(filePath: string): Promise<ParsedPart> {
  const parsed: ParsedPart = { sources: [], aliases: [], assets: [], sessionCoverage: [] };
  if (path.extname(filePath).toLowerCase() === ".json") {
    parsed.sessionList = await readSessionList(filePath);
    return parsed;
  }
  const textValue = await readFile(filePath, "utf8");
  for (const [index, line] of textValue.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value: Record<string, unknown>;
    try { value = JSON.parse(line) as Record<string, unknown>; }
    catch (error) { throw inventoryError(ERROR.manifest_mismatch, `invalid JSONL part ${index + 1}`, error); }
    if (value.record_type === "export_part") {
      if (parsed.part) throw inventoryError(ERROR.manifest_mismatch, "JSONL export part has multiple export_part records");
      parsed.part = value as unknown as InventoryExportPart;
    } else if (value.record_type === "alias") parsed.aliases.push(value as unknown as InventoryAliasSnapshot);
    else if (value.record_type === "asset") parsed.assets.push(value as unknown as InventoryAssetSnapshot);
    else if (value.record_type === "session_coverage") parsed.sessionCoverage.push(value as unknown as InventorySessionCoverage);
    else if (value.schema_version === INVENTORY_SCHEMA_VERSION && typeof value.source_kind === "string") parsed.sources.push(value as unknown as LegacySource);
    else throw inventoryError(ERROR.manifest_mismatch, "unknown export part row");
  }
  if (!parsed.part) throw inventoryError(ERROR.manifest_mismatch, "JSONL export part is missing export_part metadata");
  if (parsed.part.schema_version !== INVENTORY_SCHEMA_VERSION ||
      !Object.values(INVENTORY_EXPORT_PART_KIND).includes(parsed.part.part_kind)) {
    throw inventoryError(ERROR.manifest_mismatch, "JSONL export part metadata does not match the inventory contract");
  }
  parseInventoryCutoff(parsed.part.cutoff);
  if (!Number.isFinite(Date.parse(parsed.part.started_at)) || !Number.isFinite(Date.parse(parsed.part.ended_at))) {
    throw inventoryError(ERROR.manifest_mismatch, "JSONL export part timing is invalid");
  }
  return parsed;
}

async function uniquePartPaths(values: string[]): Promise<string[]> {
  const paths = values.map((value) => path.resolve(value));
  const seenPaths = new Set<string>();
  const seenHashes = new Set<string>();
  for (const filePath of paths) {
    const canonical = path.resolve(filePath);
    if (seenPaths.has(canonical)) throw inventoryError(ERROR.duplicate_part, "the same part was provided more than once");
    seenPaths.add(canonical);
    const hash = await sha256File(filePath);
    if (seenHashes.has(hash)) throw inventoryError(ERROR.duplicate_part, "identical part content was provided more than once");
    seenHashes.add(hash);
  }
  return paths;
}

async function readSessionList(filePath: string): Promise<InventorySessionList> {
  const value = JSON.parse(await readFile(filePath, "utf8")) as Partial<InventorySessionList>;
  if (value.record_type !== "session_list" || value.schema_version !== INVENTORY_SCHEMA_VERSION || !Array.isArray(value.session_ids) ||
      value.session_ids.some((item) => typeof item !== "string" || item.length === 0)) {
    throw inventoryError(ERROR.manifest_mismatch, "session list part does not match the inventory contract");
  }
  const cutoff = parseInventoryCutoff(value.cutoff ?? "");
  if (new Set(value.session_ids).size !== value.session_ids.length) throw inventoryError(ERROR.manifest_mismatch, "session list contains duplicate session IDs");
  return { ...value, cutoff } as InventorySessionList;
}

async function openNewOutput(filePath: string): Promise<{ jsonl(value: unknown): Promise<void>; close(): Promise<void> }> {
  const handle = await open(path.resolve(filePath), "wx", 0o600);
  return {
    async jsonl(value) { await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8"); },
    close: () => handle.close(),
  };
}

async function reportReadback(filePath: string, marker: string): Promise<void> {
  const count = await countJsonlLines(filePath);
  process.stdout.write(`${marker} rows=${count} sha256=${await sha256File(filePath)}\n`);
}

async function countJsonlLines(filePath: string): Promise<number> {
  let count = 0;
  const lines = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) throw inventoryError(ERROR.output_failed, "output JSONL contains an empty line");
    try { JSON.parse(line); }
    catch (error) { throw inventoryError(ERROR.output_failed, "output JSONL readback is invalid", error); }
    count += 1;
  }
  return count;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function parseJsonArray(value: string, label: string): unknown[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new TypeError(`${label} must be a JSON array`); }
  if (!Array.isArray(parsed)) throw new TypeError(`${label} must be a JSON array`);
  return parsed;
}
function assertAllowedOptions(options: Options, allowed: readonly string[]): void {
  if (Object.keys(options).some((name) => !allowed.includes(name))) throw new TypeError("unknown option for inventory subcommand");
}
function requiredOption(options: Options, name: string): string {
  const value = options[name];
  if (value === undefined || value.length === 0) throw new TypeError(`${name} is required`);
  return value;
}
function now(): string { return new Date().toISOString(); }
