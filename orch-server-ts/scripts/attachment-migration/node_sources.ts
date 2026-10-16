#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { collectLegacySourceTargets } from "./extract_relational.js";
import {
  INVENTORY_ERROR_CODES as ERROR,
  INVENTORY_SCHEMA_VERSION,
  inventoryError,
  type EventAttachmentCandidate,
  type ExplicitFileSource,
  type FileSourceReference,
  type LegacySource,
} from "./inventory_contract.js";

type Options = { sources: string; nodeId: string; output: string; allowedOrigins: string[] };

export function collectNodeSources(
  records: readonly unknown[],
  nodeId: string,
  allowedOrigins: readonly string[] = [],
): ExplicitFileSource[] {
  if (!nodeId) throw inventoryError(ERROR.invalid_source, "node id must be non-empty");
  const byPath = new Map<string, Map<string, ExplicitFileSource>>();
  for (const value of records) {
    if (!isRecord(value) || value.schema_version !== INVENTORY_SCHEMA_VERSION || typeof value.source_kind !== "string" ||
        typeof value.source_table !== "string" || typeof value.source_pk !== "string" || typeof value.source_pointer !== "string" ||
        !isRecord(value.data)) continue;
    const source = value as unknown as LegacySource;
    if (source.source_kind === "message") {
      addEventPaths(source, nodeId, byPath);
      continue;
    }
    for (const target of collectLegacySourceTargets(source, { allowedOrigins })) {
      if (target.classification !== "legacy_path" || target.legacy_node_id !== nodeId || !target.raw_path) continue;
      addSourcePath(target.raw_path, target.pointer, source, nodeId, byPath);
    }
  }
  return [...byPath.values()].flatMap((references) => [...references.values()]);
}

function addEventPaths(
  source: LegacySource,
  nodeId: string,
  byPath: Map<string, Map<string, ExplicitFileSource>>,
): void {
  if (source.data.source_node_id !== nodeId || !Array.isArray(source.data.attachment_candidates)) return;
  for (const candidate of source.data.attachment_candidates as EventAttachmentCandidate[]) {
    if (typeof candidate.value !== "string") continue;
    if (candidate.kind !== "input_path" && !(candidate.kind === "managed_path_note" && candidate.verified === true)) continue;
    addSourcePath(candidate.value, candidate.pointer, source, nodeId, byPath);
  }
}

function addSourcePath(
  sourcePath: string,
  pointer: string,
  source: LegacySource,
  nodeId: string,
  byPath: Map<string, Map<string, ExplicitFileSource>>,
): void {
  if (sourcePath.length === 0) return;
  const reference: FileSourceReference = {
    source_kind: source.source_kind,
    source_table: source.source_table,
    source_pk: source.source_pk,
    source_pointer: pointer,
    ...(source.session_id === undefined ? {} : { session_id: source.session_id }),
    ...(source.card_id === undefined ? {} : { card_id: source.card_id }),
  };
  const referenceKey = JSON.stringify(reference);
  const references = byPath.get(sourcePath) ?? new Map<string, ExplicitFileSource>();
  references.set(referenceKey, { node_id: nodeId, path: sourcePath, source_ref: reference });
  byPath.set(sourcePath, references);
}

async function main(args: string[]): Promise<void> {
  const options = parseArgs(args);
  const rows = await readJsonl(options.sources);
  const sources = collectNodeSources(rows, options.nodeId, options.allowedOrigins);
  const output = await open(path.resolve(options.output), "wx", 0o600);
  try { await output.writeFile(`${JSON.stringify(sources)}\n`, "utf8"); }
  finally { await output.close(); }
  const readback = JSON.parse(await readFile(path.resolve(options.output), "utf8")) as unknown;
  if (!Array.isArray(readback) || readback.length !== sources.length) throw inventoryError(ERROR.output_failed, "node source output readback failed");
  process.stdout.write(`NODE_SOURCES_EXPORTED rows=${sources.length} sha256=${await sha256File(options.output)}\n`);
}

async function readJsonl(filePath: string): Promise<unknown[]> {
  const values: unknown[] = [];
  const stream = createReadStream(path.resolve(filePath), { encoding: "utf8" });
  let remainder = "";
  for await (const chunk of stream) {
    const lines = `${remainder}${chunk}`.split("\n");
    remainder = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) values.push(parseLine(line));
  }
  if (remainder.trim()) values.push(parseLine(remainder));
  return values;
}

function parseLine(line: string): unknown {
  try { return JSON.parse(line) as unknown; }
  catch (error) { throw inventoryError(ERROR.manifest_mismatch, "source bundle contains invalid JSONL", error); }
}

function parseArgs(args: string[]): Options {
  const values: Record<string, string> = {};
  if (args.length % 2 !== 0) throw new TypeError("usage: node_sources.ts --sources <bundle.jsonl> --node-id <id> --output <json> [--allowed-origins <JSON array>]");
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    const value = args[index + 1]!;
    if (!flag.startsWith("--") || value.startsWith("--") || values[flag] !== undefined ||
        !["--sources", "--node-id", "--output", "--allowed-origins"].includes(flag)) throw new TypeError("invalid or repeated node source option");
    values[flag] = value;
  }
  const sources = values["--sources"];
  const nodeId = values["--node-id"];
  const output = values["--output"];
  if (!sources || !nodeId || !output) throw new TypeError("usage: node_sources.ts --sources <bundle.jsonl> --node-id <id> --output <json> [--allowed-origins <JSON array>]");
  let allowedOrigins: unknown = [];
  if (values["--allowed-origins"] !== undefined) {
    try { allowedOrigins = JSON.parse(values["--allowed-origins"]!); }
    catch { throw new TypeError("--allowed-origins must be a JSON array"); }
  }
  if (!Array.isArray(allowedOrigins) || allowedOrigins.some((item) => typeof item !== "string")) throw new TypeError("--allowed-origins must be a JSON array of origins");
  return { sources, nodeId, output, allowedOrigins: allowedOrigins as string[] };
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path.resolve(filePath))) hash.update(chunk);
  return hash.digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "INVENTORY_NODE_SOURCES_FAILED";
    console.error(`${code}: could not export node source list`);
    process.exitCode = 1;
  });
}
