#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, realpath, readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  FILE_OBSERVATION_STATUS as FILE_STATUS,
  INVENTORY_ERROR_CODES as ERROR_CODES,
  INVENTORY_SCHEMA_VERSION as SCHEMA_VERSION,
  NODE_INVENTORY_RECORDED,
  inventoryError,
  parseInventoryCutoff,
} from "./inventory_contract.ts";

const INCOMPLETE_STATUSES = new Set([
  FILE_STATUS.unstable,
  FILE_STATUS.path_denied,
  FILE_STATUS.not_regular,
  FILE_STATUS.source_absent,
  FILE_STATUS.root_unconfirmed,
  FILE_STATUS.hash_interrupted,
]);

export async function* scanNodeSources({ nodeId, incomingRoot, explicitSources, allowedRoots, signal, cutoff }) {
  if (typeof nodeId !== "string" || nodeId.length === 0) throw inventoryError(ERROR_CODES.invalid_source, "nodeId must be non-empty");
  if (!Array.isArray(explicitSources) || !Array.isArray(allowedRoots)) throw inventoryError(ERROR_CODES.invalid_source, "explicitSources and allowedRoots must be arrays");
  const canonicalCutoff = parseInventoryCutoff(cutoff);
  const cutoffDate = new Date(canonicalCutoff);
  const incomingLexical = requireAbsolute(incomingRoot, "incomingRoot");
  const rootPaths = [];
  const rootRealPaths = [];
  for (const root of allowedRoots) {
    try {
      const lexical = requireAbsolute(root, "allowedRoots entry");
      const canonical = await realpath(lexical);
      if (!(await stat(canonical)).isDirectory()) throw new Error("allowed root is not a directory");
      rootPaths.push(lexical);
      rootRealPaths.push(canonical);
    } catch {
      yield diagnostic(nodeId, FILE_STATUS.root_unconfirmed, ERROR_CODES.root_unconfirmed);
    }
  }

  let incomingReal = null;
  try {
    incomingReal = await realpath(incomingLexical);
    if (!(await stat(incomingReal)).isDirectory() || !isAllowed(incomingReal, rootRealPaths)) throw new Error("incoming root is outside confirmed roots");
  } catch {
    yield diagnostic(nodeId, FILE_STATUS.root_unconfirmed, ERROR_CODES.root_unconfirmed, incomingLexical);
    incomingReal = null;
  }

  const explicitGroups = new Map();
  for (const source of explicitSources) {
    validateExplicitSource(source);
    if (source.node_id !== nodeId) {
      yield diagnostic(nodeId, FILE_STATUS.path_denied, ERROR_CODES.path_denied, source.path, [source.source_ref]);
      continue;
    }
    const sourcePath = source.physical_path === undefined
      ? (path.isAbsolute(source.path) ? source.path : path.resolve(incomingLexical, source.path))
      : requireAbsolute(source.physical_path, "explicitSources.physical_path");
    if (!isAllowed(sourcePath, rootPaths)) {
      yield diagnostic(nodeId, FILE_STATUS.path_denied, ERROR_CODES.path_denied, source.path, [source.source_ref], sourcePath);
      continue;
    }
    let canonical;
    try {
      canonical = await realpath(sourcePath);
    } catch {
      yield diagnostic(nodeId, FILE_STATUS.source_absent, ERROR_CODES.source_absent, source.path, [source.source_ref], sourcePath);
      continue;
    }
    if (!isAllowed(canonical, rootRealPaths)) {
      yield diagnostic(nodeId, FILE_STATUS.path_denied, ERROR_CODES.path_denied, source.path, [source.source_ref], canonical);
      continue;
    }
    let group = explicitGroups.get(canonical);
    if (!group) {
      group = { path: canonical, knownSourcePaths: [], sourceRefs: [] };
      explicitGroups.set(canonical, group);
    }
    group.knownSourcePaths.push(source.path);
    group.sourceRefs.push(source.source_ref);
  }

  if (incomingReal !== null) {
    for await (const entry of enumerate(incomingReal)) {
      if (entry.error) {
        yield diagnostic(nodeId, FILE_STATUS.path_denied, ERROR_CODES.path_denied, undefined, [], entry.path);
        continue;
      }
      let canonical;
      try {
        canonical = await realpath(entry.path);
      } catch {
        yield diagnostic(nodeId, FILE_STATUS.source_absent, ERROR_CODES.source_absent, undefined, [], entry.path, entry.relativePath);
        continue;
      }
      if (!isAllowed(canonical, rootRealPaths)) {
        yield diagnostic(nodeId, FILE_STATUS.path_denied, ERROR_CODES.path_denied, undefined, [], canonical, entry.relativePath);
        continue;
      }
      const group = explicitGroups.get(canonical);
      yield await observeFile({
        nodeId,
        path: canonical,
        incomingRelativePath: entry.relativePath,
        knownSourcePaths: group?.knownSourcePaths ?? [],
        sourceRefs: group?.sourceRefs ?? [],
        cutoffDate,
        signal,
      });
      explicitGroups.delete(canonical);
    }
  }

  for (const group of explicitGroups.values()) {
    const incomingRelativePath = incomingReal !== null && isPathWithin(incomingReal, group.path)
      ? path.relative(incomingReal, group.path)
      : undefined;
    yield await observeFile({
      nodeId,
      path: group.path,
      incomingRelativePath,
      knownSourcePaths: group.knownSourcePaths,
      sourceRefs: group.sourceRefs,
      cutoffDate,
      signal,
    });
  }
}

export function isPathWithin(root, target, flavor = "native") {
  const api = flavor === "win32" ? path.win32 : path;
  const relative = api.relative(api.resolve(root), api.resolve(target));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative));
}

export async function hashOpenedFile(handle, cutoffDate, signal, expectedPath) {
  const before = await handle.stat();
  if (!before.isFile()) return {
    status: FILE_STATUS.not_regular,
    sizeBytes: before.size,
    mtimeMs: before.mtimeMs,
    errorCode: ERROR_CODES.not_regular,
  };
  if (signal?.aborted) return { status: FILE_STATUS.hash_interrupted, sizeBytes: before.size, mtimeMs: before.mtimeMs, errorCode: ERROR_CODES.hash_interrupted };

  const digest = createHash("sha256");
  let bytesRead = 0;
  const stream = handle.createReadStream({ autoClose: false });
  const abortRead = () => stream.destroy(abortError());
  signal?.addEventListener("abort", abortRead, { once: true });
  try {
    for await (const chunk of stream) {
      if (signal?.aborted) throw abortError();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      digest.update(bytes);
      bytesRead += bytes.byteLength;
    }
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") {
      return { status: FILE_STATUS.hash_interrupted, sizeBytes: before.size, bytesRead, mtimeMs: before.mtimeMs, errorCode: ERROR_CODES.hash_interrupted };
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", abortRead);
  }

  const after = await handle.stat();
  let namedAfter;
  if (expectedPath !== undefined) {
    try {
      namedAfter = await stat(expectedPath);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        return {
          status: FILE_STATUS.unstable,
          sizeBytes: before.size,
          bytesRead,
          mtimeMs: before.mtimeMs,
          sha256: digest.digest("hex"),
          afterCutoff: before.mtimeMs > cutoffDate.getTime(),
          errorCode: ERROR_CODES.file_changed,
        };
      }
      throw error;
    }
  }
  const changed = !sameFileVersion(before, after) || bytesRead !== after.size ||
    (namedAfter !== undefined && !sameFileVersion(after, namedAfter));
  const afterCutoff = before.mtimeMs > cutoffDate.getTime();
  const status = changed ? FILE_STATUS.unstable : afterCutoff ? FILE_STATUS.after_cutoff : FILE_STATUS.observed;
  return {
    status,
    sizeBytes: before.size,
    bytesRead,
    mtimeMs: before.mtimeMs,
    sha256: digest.digest("hex"),
    afterCutoff,
    errorCode: changed ? ERROR_CODES.file_changed : undefined,
  };
}

async function observeFile({ nodeId, path: filePath, incomingRelativePath, knownSourcePaths, sourceRefs, cutoffDate, signal }) {
  let handle;
  try {
    if (signal?.aborted) return diagnostic(nodeId, FILE_STATUS.hash_interrupted, ERROR_CODES.hash_interrupted, knownSourcePaths[0], sourceRefs, filePath, incomingRelativePath);
    if (!(await stat(filePath)).isFile()) {
      return diagnostic(nodeId, FILE_STATUS.not_regular, ERROR_CODES.not_regular, knownSourcePaths[0], sourceRefs, filePath, incomingRelativePath);
    }
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const result = await hashOpenedFile(handle, cutoffDate, signal, filePath);
    const incomplete = INCOMPLETE_STATUSES.has(result.status);
    return {
      record_type: "file",
      schema_version: SCHEMA_VERSION,
      node_id: nodeId,
      status: result.status,
      known_source_paths: knownSourcePaths,
      ...(incomingRelativePath === undefined ? {} : { incoming_relative_path: incomingRelativePath }),
      physical_path: filePath,
      source_refs: sourceRefs,
      ...(result.sizeBytes === undefined ? {} : { size_bytes: result.sizeBytes }),
      ...(result.bytesRead === undefined ? {} : { bytes_read: result.bytesRead }),
      ...(result.mtimeMs === undefined ? {} : { mtime_ms: result.mtimeMs, mtime: new Date(result.mtimeMs).toISOString() }),
      ...(result.sha256 === undefined ? {} : { sha256: result.sha256 }),
      after_cutoff: result.afterCutoff ?? false,
      eligible_candidate: result.status === FILE_STATUS.observed,
      coverage_complete: !incomplete,
      ...(result.errorCode === undefined ? {} : { error_code: result.errorCode }),
    };
  } catch (error) {
    const missing = error?.code === "ENOENT" || error?.code === "ENOTDIR";
    const status = missing ? FILE_STATUS.source_absent : FILE_STATUS.path_denied;
    return diagnostic(nodeId, status, missing ? ERROR_CODES.source_absent : ERROR_CODES.path_denied,
      knownSourcePaths[0], sourceRefs, filePath, incomingRelativePath);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function* enumerate(root, relativeDirectory = "") {
  const directory = path.join(root, relativeDirectory);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    yield { path: directory, relativePath: relativeDirectory || ".", error: true };
    return;
  }
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      yield* enumerate(root, relativePath);
    } else {
      yield { path: path.join(root, relativePath), relativePath };
    }
  }
}

function diagnostic(nodeId, status, errorCode, knownSourcePath, sourceRefs = [], physicalPath, incomingRelativePath) {
  return {
    record_type: "file",
    schema_version: SCHEMA_VERSION,
    node_id: nodeId,
    status,
    known_source_paths: knownSourcePath === undefined ? [] : [knownSourcePath],
    ...(incomingRelativePath === undefined ? {} : { incoming_relative_path: incomingRelativePath }),
    ...(physicalPath === undefined ? {} : { physical_path: physicalPath }),
    source_refs: sourceRefs,
    after_cutoff: false,
    eligible_candidate: false,
    coverage_complete: false,
    error_code: errorCode,
  };
}

function validateExplicitSource(source) {
  if (!source || typeof source !== "object" || Array.isArray(source) || typeof source.node_id !== "string" ||
      typeof source.path !== "string" || source.path.length === 0 || !isSourceReference(source.source_ref)) {
    throw inventoryError(ERROR_CODES.invalid_source, "explicit source must include node_id, path, and source_ref");
  }
}

function isSourceReference(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    typeof value.source_kind === "string" && typeof value.source_table === "string" &&
    typeof value.source_pk === "string" && typeof value.source_pointer === "string";
}

function requireAbsolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw inventoryError(ERROR_CODES.invalid_source, `${label} must be an absolute path`);
  return path.resolve(value);
}

function isAllowed(candidate, roots) {
  return roots.some((root) => isPathWithin(root, candidate));
}

function sameFileVersion(left, right) {
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs &&
    left.dev === right.dev && left.ino === right.ino;
}

function abortError() {
  return Object.assign(new Error("file hashing interrupted"), { name: "AbortError" });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [explicitSources, allowedRoots] = await Promise.all([
    readJsonArray(args.sources, "--sources"),
    readJsonArray(args.allowedRoots, "--allowed-roots"),
  ]);
  const incomingRoot = requireAbsolute(args.incomingRoot, "--incoming-root");
  const outputPath = requireAbsolute(args.output, "--output");
  let incomingCanonical = incomingRoot;
  try {
    incomingCanonical = await realpath(incomingRoot);
  } catch {
    // The scanner records the missing incoming root as incomplete coverage.
  }
  const outputParentCanonical = await realpath(path.dirname(outputPath));
  const outputCanonical = path.join(outputParentCanonical, path.basename(outputPath));
  if (isPathWithin(incomingRoot, outputPath) || isPathWithin(incomingCanonical, outputCanonical)) {
    throw inventoryError(ERROR_CODES.invalid_source, "--output must be outside --incoming-root");
  }
  const startedAt = new Date().toISOString();
  const cutoff = parseInventoryCutoff(args.cutoff);
  const output = await open(outputPath, "wx", 0o600);
  const summaryStats = createSummaryStats();
  let fatalError;
  let incomingCensusComplete = true;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  try {
    for await (const observation of scanNodeSources({
      nodeId: args.nodeId,
      incomingRoot,
      explicitSources,
      allowedRoots,
      cutoff,
      signal: controller.signal,
    })) {
      addObservation(summaryStats, observation);
      if (observation.status === FILE_STATUS.root_unconfirmed ||
          (observation.incoming_relative_path !== undefined && !observation.coverage_complete)) incomingCensusComplete = false;
      await writeLine(output, observation);
      if (observation.status === FILE_STATUS.hash_interrupted) break;
    }
  } catch (error) {
    fatalError = error;
    process.stderr.write(`${error.message}\n`);
  } finally {
    process.removeListener("SIGINT", interrupt);
  }
  const confirmedIncomingRoot = incomingCensusComplete && fatalError === undefined ? incomingCanonical : undefined;
  const summary = buildSummary(args.nodeId, cutoff, startedAt, summaryStats, fatalError, confirmedIncomingRoot, confirmedIncomingRoot !== undefined);
  await writeLine(output, summary);
  await output.close();
  process.stdout.write(`${NODE_INVENTORY_RECORDED} files=${summary.file_count} bytes=${summary.bytes_hashed} coverage_complete=${summary.coverage_complete}\n`);
  if (!summary.coverage_complete || controller.signal.aborted || fatalError) process.exitCode = controller.signal.aborted ? 130 : 2;
}

function parseArgs(values) {
  const names = new Map([
    ["--node-id", "nodeId"],
    ["--incoming-root", "incomingRoot"],
    ["--sources", "sources"],
    ["--allowed-roots", "allowedRoots"],
    ["--cutoff", "cutoff"],
    ["--output", "output"],
  ]);
  const args = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = names.get(values[index]);
    const value = values[index + 1];
    if (key === undefined || value === undefined || args[key] !== undefined) throw new Error("usage: scan_node.mjs --node-id ID --incoming-root ABS --sources JSON --allowed-roots JSON --cutoff UTC --output ABS");
    args[key] = value;
  }
  for (const name of names.values()) if (args[name] === undefined) throw new Error(`missing required option for ${name}`);
  return args;
}

async function readJsonArray(filePath, flag) {
  const absolute = requireAbsolute(filePath, flag);
  const value = JSON.parse(await readFile(absolute, "utf8"));
  if (!Array.isArray(value)) throw inventoryError(ERROR_CODES.invalid_source, `${flag} must contain a JSON array`);
  return value;
}

async function writeLine(output, record) {
  await output.writeFile(`${JSON.stringify(record)}\n`);
}

function createSummaryStats() {
  return {
    statusCounts: {},
    bytesHashed: 0,
    hashesCompleted: 0,
    fileCount: 0,
    afterCutoffCount: 0,
    coverageComplete: true,
  };
}

function addObservation(stats, observation) {
  stats.statusCounts[observation.status] = (stats.statusCounts[observation.status] ?? 0) + 1;
  if (observation.size_bytes !== undefined) stats.fileCount += 1;
  stats.bytesHashed += observation.bytes_read ?? 0;
  if (observation.sha256 !== undefined) stats.hashesCompleted += 1;
  if (observation.status === FILE_STATUS.after_cutoff || observation.after_cutoff) stats.afterCutoffCount += 1;
  if (!observation.coverage_complete || INCOMPLETE_STATUSES.has(observation.status)) stats.coverageComplete = false;
}

function buildSummary(nodeId, cutoff, startedAt, stats, fatalError, incomingRoot, incomingCensusComplete) {
  return {
    record_type: "summary",
    schema_version: SCHEMA_VERSION,
    node_id: nodeId,
    ...(incomingRoot === undefined ? {} : { incoming_root: incomingRoot }),
    incoming_census_complete: incomingCensusComplete,
    cutoff,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    coverage_complete: stats.coverageComplete && fatalError === undefined,
    file_count: stats.fileCount,
    bytes_hashed: stats.bytesHashed,
    hashes_completed: stats.hashesCompleted,
    after_cutoff_count: stats.afterCutoffCount,
    status_counts: stats.statusCounts,
    ...(fatalError?.code === undefined ? {} : { error_code: fatalError.code }),
  };
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}
