import { createHash } from "node:crypto";
import path from "node:path";
import { normalizeAttachmentLegacyPath } from "../../src/attachments/attachment_read_service.js";
import { collectLegacySourceTargets } from "./extract_relational.js";
import {
  FILE_OBSERVATION_STATUS as FILE,
  INVENTORY_ERROR_CODES as ERROR,
  INVENTORY_NODE_COVERAGE_STATUS as NODE,
  INVENTORY_PLAN_MARKER,
  INVENTORY_PLAN_STATUS as STATUS,
  INVENTORY_SCHEMA_VERSION,
  inventoryError,
  parseInventoryCutoff,
  type EventAttachmentCandidate,
  type FileObservation,
  type InventoryAliasSnapshot,
  type InventoryAssetSnapshot,
  type InventoryDirectReference,
  type InventoryNodeCoverage,
  type InventoryOwnerEvidence,
  type InventoryPlan,
  type InventoryPlanAnomaly,
  type InventoryPlanIdentity,
  type InventoryPlanReference,
  type InventoryPlanSummary,
  type InventoryRunBundleMetadata,
  type InventorySessionCoverage,
  type LegacySource,
  type LegacyTarget,
  type NodeScanSummary,
} from "./inventory_contract.js";

type NodeInput = InventoryNodeCoverage | NodeScanSummary;
type Input = {
  sources: readonly LegacySource[];
  observations: readonly FileObservation[];
  assets: readonly InventoryAssetSnapshot[];
  aliases: readonly InventoryAliasSnapshot[];
  nodeCoverage: readonly NodeInput[];
  metadata: InventoryRunBundleMetadata;
  sessionCoverage?: readonly InventorySessionCoverage[];
  allowedOrigins?: readonly string[];
};
type Occurrence = { node: string; path: string; target: LegacyTarget; source: LegacySource; owner: InventoryOwnerEvidence };
type Group = { node: string; path: string; owner: InventoryOwnerEvidence; ownerConflict: boolean; refs: InventoryPlanReference[] };
const CARD_REFERENCE_KINDS = new Set(["card_request", "card_item", "item_history", "report", "comment", "note"]);

const MIME: Readonly<Record<string, string>> = {
  ".gif": "image/gif", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".json": "application/json",
  ".md": "text/markdown", ".pdf": "application/pdf", ".png": "image/png", ".txt": "text/plain", ".webp": "image/webp",
};
const MAX_BYTES = 100 * 1024 * 1024;

export function buildLegacyAttachmentPlan(input: Input): InventoryPlan {
  const startedAt = new Date().toISOString();
  validateMetadata(input.metadata);
  const cutoff = Date.parse(parseInventoryCutoff(input.metadata.cutoff));
  const errors = new Set<string>();
  const anomalies: InventoryPlanAnomaly[] = [];
  const assets = mergeAssets([...input.assets, ...readAssetSources(input.sources, cutoff)], errors, anomalies);
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const nodes = ensureNodes(input.metadata.expected_node_ids, readNodeCoverage(input.nodeCoverage, input.metadata.cutoff), errors, anomalies);
  for (const row of input.nodeCoverage) if (row.record_type === "summary" && row.cutoff !== input.metadata.cutoff) {
    errors.add(ERROR.manifest_mismatch);
    anomalies.push({ code: ERROR.manifest_mismatch, subject: row.node_id, message: "node summary cutoff differs from source metadata" });
  }
  const nodeById = new Map(nodes.map((node) => [node.node_id, node]));
  const censusRoots = censusRootsCompletedExceptForExplicitAbsences(input.nodeCoverage);
  const sessions = latestSessions(input.sessionCoverage ?? []);
  const sessionById = new Map(sessions.map((session) => [session.session_id, session]));
  let complete = input.metadata.relational_coverage_complete && input.metadata.alias_snapshot_complete && input.metadata.coverage_complete !== false;
  if (!complete) errors.add(ERROR.manifest_mismatch);
  if (input.metadata.coverage_complete === false) errors.add(ERROR.coverage_incomplete);
  for (const stage of ["relational", "events", "node_scan"] as const) {
    if (input.metadata.stages[stage] === undefined) {
      complete = false;
      errors.add(ERROR.manifest_mismatch);
      anomalies.push({ code: ERROR.manifest_mismatch, subject: stage, message: "stage timing is missing" });
    }
  }
  for (const id of input.metadata.event_session_ids) {
    const session = sessionById.get(id);
    if (!session?.coverage_complete) {
      complete = false;
      errors.add(session?.error_code ?? ERROR.manifest_mismatch);
    }
  }
  if (nodes.some((node) => !node.coverage_complete)) complete = false;

  const aliases = indexAliases(input.aliases, errors, anomalies);
  const targets: Occurrence[] = [];
  const direct: InventoryDirectReference[] = [];
  const ambiguous: InventoryPlan["ambiguous_targets"] = [];
  for (const source of input.sources) {
    validateSource(source);
    if (Date.parse(source.created_at) > cutoff) continue;
    const updatedAfter = source.updated_at !== undefined && Date.parse(source.updated_at) > cutoff;
    const effective = { ...source, changed_after_cutoff: source.changed_after_cutoff || updatedAfter };
    if (effective.changed_after_cutoff) {
      complete = false;
      anomalies.push({ code: "changed_after_cutoff", subject: `${source.source_table}:${source.source_pk}`, message: "current contents may differ from cutoff contents" });
    }
    if (source.source_kind === "existing_asset" && source.source_table === "file_assets") continue;
    if (source.source_kind === "existing_asset" && source.source_table === "board_items") {
      const ref = addBoardAsset(effective, direct, assetById);
      if (ref && (ref.storage_purpose !== "board" || ref.upload_status !== "committed" || ref.storage_verified !== true)) complete = false;
      continue;
    }
    const owner = getOwner(effective);
    const sourceTargets = effective.source_kind === "message"
      ? getEventTargets(effective, direct, assetById, anomalies)
      : collectLegacySourceTargets(effective, { allowedOrigins: input.allowedOrigins });
    for (const target of sourceTargets) {
      if (target.classification !== "legacy_path") {
        ambiguous.push({ source_pk: effective.source_pk, pointer: target.pointer, raw_url: target.raw_url, raw_path: target.raw_path, reason: target.reason });
        anomalies.push({ code: "ambiguous_target", subject: `${effective.source_pk}${target.pointer}`, message: target.reason ?? "target is ambiguous" });
        complete = false;
      } else if (!target.legacy_node_id || !target.raw_path) {
        ambiguous.push({ source_pk: effective.source_pk, pointer: target.pointer, raw_path: target.raw_path, reason: "missing node or path" });
        complete = false;
      } else {
        targets.push({ node: target.legacy_node_id, path: normalizeAttachmentLegacyPath(target.normalized_path ?? target.raw_path), target, source: effective, owner });
      }
    }
  }

  for (const ref of direct) if (ref.kind !== "board_asset" && ref.attachment_id && !ref.resolved_asset_id) {
    complete = false;
    errors.add(ERROR.manifest_mismatch);
    anomalies.push({ code: ERROR.manifest_mismatch, subject: `${ref.source_table}:${ref.source_pk}${ref.pointer}`, message: "attachment ID has no matching asset snapshot" });
  }

  const groups = groupTargets(targets);
  const identities: InventoryPlanIdentity[] = [];
  const used = new Set<FileObservation>();
  const aliasSnapshotUsable = input.metadata.alias_snapshot_complete && !errors.has(ERROR.alias_conflict);
  for (const group of groups) {
    const matches = input.observations.filter((file) => matchesFile(file, group));
    matches.forEach((file) => used.add(file));
    const observation = matches.find((file) => file.status === FILE.observed && file.eligible_candidate) ?? matches[0];
    const alias = aliases.get(locKey(group.node, group.path));
    const asset = alias?.asset_id ? assetById.get(alias.asset_id) : undefined;
    const resolved = resolve(group, observation, alias, asset, nodeById.get(group.node), aliasSnapshotUsable, censusRoots.get(group.node));
    const identity = makeIdentity(group, observation, alias, asset, resolved);
    identities.push(identity);
    if (!identity.coverage_complete) complete = false;
    if (resolved.error) errors.add(resolved.error);
  }

  for (const file of input.observations) {
    if (used.has(file) || file.source_refs.length > 0 || !file.incoming_relative_path) continue;
    const pathName = normalizeAttachmentLegacyPath(file.incoming_relative_path);
    const owner: InventoryOwnerEvidence = { status: "unverified", reason: "incoming file has no source owner", source: "incoming_file" };
    const group: Group = { node: file.node_id, path: pathName, owner, ownerConflict: false, refs: [] };
    const alias = aliases.get(locKey(file.node_id, pathName));
    const asset = alias?.asset_id ? assetById.get(alias.asset_id) : undefined;
    const resolved = resolve(group, file, alias, asset, nodeById.get(file.node_id), aliasSnapshotUsable, censusRoots.get(file.node_id), true);
    identities.push(makeIdentity(group, file, alias, asset, resolved, true));
    if (!resolved.coverage) complete = false;
    if (resolved.error) errors.add(resolved.error);
  }

  if (errors.size > 0) complete = false;
  checkAnomalies(assets, input.observations, identities, anomalies);
  const stageTimings = { ...input.metadata.stages, plan: { started_at: startedAt, ended_at: new Date().toISOString() } };
  if (errors.size > 0) complete = false;
  const summary = summarize(input.metadata, complete, identities, input.observations, nodes, sessions, direct, ambiguous.length, assets, anomalies, [...errors], stageTimings);
  return { metadata: input.metadata, stage_timings: stageTimings, coverage_complete: complete, identities, direct_references: direct,
    ambiguous_targets: ambiguous, anomalies, node_coverage: nodes, session_coverage: sessions, existing_assets: assets, summary };
}

function validateMetadata(value: InventoryRunBundleMetadata): void {
  if (value.record_type !== "run_metadata" || value.schema_version !== INVENTORY_SCHEMA_VERSION || !value.scan_id ||
      !/^[0-9a-f]{7,40}$/i.test(value.baseline_sha) || !Array.isArray(value.expected_node_ids) || !Array.isArray(value.event_session_ids)) {
    throw inventoryError(ERROR.manifest_mismatch, "run metadata does not match the inventory contract");
  }
  parseInventoryCutoff(value.cutoff);
}

function validateSource(source: LegacySource): void {
  if (source.schema_version !== INVENTORY_SCHEMA_VERSION || !source.source_pk || !isRecord(source.data) || !Number.isFinite(Date.parse(source.created_at))) {
    throw inventoryError(ERROR.manifest_mismatch, "source record does not match the inventory contract");
  }
  if (source.updated_at !== undefined && !Number.isFinite(Date.parse(source.updated_at))) throw inventoryError(ERROR.manifest_mismatch, "source updated_at is invalid");
}

function readAssetSources(sources: readonly LegacySource[], cutoff: number): InventoryAssetSnapshot[] {
  return sources.filter((source) => source.source_kind === "existing_asset" && source.source_table === "file_assets" && Date.parse(source.created_at) <= cutoff).map((source) => ({
    id: source.source_pk, storage_purpose: text(source.data.storage_purpose), storage_key: maybeText(source.data.storage_key),
    storage_endpoint: maybeText(source.data.storage_endpoint), storage_bucket: maybeText(source.data.storage_bucket), upload_status: text(source.data.upload_status),
    original_name: maybeText(source.data.original_name), mime_type: maybeText(source.data.mime_type), byte_size: numberOrNull(source.data.byte_size),
    checksum_sha256: maybeText(source.data.checksum_sha256), garbage_collected_at: maybeText(source.data.garbage_collected_at),
    owner_kind: maybeText(source.data.owner_kind), owner_key: maybeText(source.data.owner_key), registration_scope: source.data.registration_scope,
    changed_after_cutoff: source.changed_after_cutoff || (source.updated_at !== undefined && Date.parse(source.updated_at) > cutoff),
  }));
}

function mergeAssets(input: readonly InventoryAssetSnapshot[], errors: Set<string>, anomalies: InventoryPlanAnomaly[]): InventoryAssetSnapshot[] {
  const result = new Map<string, InventoryAssetSnapshot>();
  for (const asset of input) {
    const old = result.get(asset.id);
    if (old && ["storage_purpose", "storage_key", "storage_endpoint", "storage_bucket", "upload_status", "original_name", "mime_type", "byte_size", "checksum_sha256", "garbage_collected_at", "owner_kind", "owner_key"]
      .some((key) => old[key as keyof InventoryAssetSnapshot] !== asset[key as keyof InventoryAssetSnapshot])) {
      errors.add(ERROR.manifest_mismatch);
      anomalies.push({ code: ERROR.manifest_mismatch, subject: asset.id, message: "conflicting asset snapshots" });
    } else result.set(asset.id, { ...old, ...asset, storage_verified: old?.storage_verified ?? asset.storage_verified,
      changed_after_cutoff: old?.changed_after_cutoff || asset.changed_after_cutoff });
  }
  return [...result.values()];
}

function readNodeCoverage(values: readonly NodeInput[], cutoff: string): InventoryNodeCoverage[] {
  const result = new Map<string, InventoryNodeCoverage>();
  for (const value of values) {
    if (value.record_type === "summary") {
      const mismatch = value.cutoff !== cutoff;
      result.set(value.node_id, { record_type: "node_coverage", schema_version: value.schema_version, node_id: value.node_id,
        status: value.coverage_complete && !mismatch ? NODE.scanned : NODE.partial, coverage_complete: value.coverage_complete && !mismatch,
        observed_at: value.ended_at, ...(value.error_code === undefined ? {} : { error_code: value.error_code }),
      });
    } else result.set(value.node_id, value);
  }
  return [...result.values()];
}

function ensureNodes(expected: readonly string[], input: readonly InventoryNodeCoverage[], errors: Set<string>, anomalies: InventoryPlanAnomaly[]): InventoryNodeCoverage[] {
  const result = new Map(input.map((node) => [node.node_id, node]));
  for (const id of expected) if (!result.has(id)) {
    errors.add(ERROR.manifest_mismatch);
    anomalies.push({ code: ERROR.manifest_mismatch, subject: id, message: "expected node has no coverage record" });
    result.set(id, { record_type: "node_coverage", schema_version: INVENTORY_SCHEMA_VERSION, node_id: id,
      status: NODE.not_reported, coverage_complete: false, observed_at: new Date().toISOString(), error_code: ERROR.manifest_mismatch });
  }
  return [...result.values()];
}

function latestSessions(values: readonly InventorySessionCoverage[]): InventorySessionCoverage[] {
  const latest = new Map<string, InventorySessionCoverage>();
  for (const item of values) {
    if (item.record_type !== "session_coverage" || item.schema_version !== INVENTORY_SCHEMA_VERSION) throw inventoryError(ERROR.manifest_mismatch, "session coverage record is invalid");
    const previous = latest.get(item.session_id);
    if (!previous || item.observed_at >= previous.observed_at) latest.set(item.session_id, item);
  }
  return [...latest.values()];
}

function indexAliases(values: readonly InventoryAliasSnapshot[], errors: Set<string>, anomalies: InventoryPlanAnomaly[]): Map<string, InventoryAliasSnapshot> {
  const aliases = new Map<string, InventoryAliasSnapshot>();
  for (const item of values) {
    const key = locKey(item.node_id, item.normalized_path);
    if (!item.node_id || !item.normalized_path || (item.availability === "resolved") !== (item.asset_id !== null) || aliases.has(key)) {
      errors.add(ERROR.alias_conflict);
      anomalies.push({ code: ERROR.alias_conflict, subject: key, message: "invalid or duplicate alias row" });
    } else aliases.set(key, item);
  }
  return aliases;
}

function getEventTargets(source: LegacySource, direct: InventoryDirectReference[], assets: ReadonlyMap<string, InventoryAssetSnapshot>, anomalies: InventoryPlanAnomaly[]): LegacyTarget[] {
  const candidates = source.data.attachment_candidates;
  if (candidates === undefined) return [];
  if (!Array.isArray(candidates)) throw inventoryError(ERROR.event_shape_invalid, "event attachment_candidates must be an array");
  const targets: LegacyTarget[] = [];
  for (const item of candidates as EventAttachmentCandidate[]) {
    if (item.kind === "attachment_id") {
      direct.push(directRef(source, item.kind, item.pointer, typeof item.value === "string" ? item.value : undefined, assets));
    } else if (item.kind === "output_descriptor") {
      const descriptor = isRecord(item.value) ? item.value : {};
      const ref = directRef(source, item.kind, item.pointer, text(descriptor.attachment_id) || undefined, assets);
      ref.name = maybeText(descriptor.name) ?? undefined;
      ref.mime_type = maybeText(descriptor.mime_type) ?? undefined;
      direct.push(ref);
    } else if (typeof item.value === "string") {
      const node = text(source.data.source_node_id);
      const verified = item.kind === "input_path" || item.verified === true;
      targets.push(verified && node ? { pointer: item.pointer, raw_path: item.value, normalized_path: normalizeAttachmentLegacyPath(item.value), legacy_node_id: node, classification: "legacy_path" }
      : { pointer: item.pointer, raw_path: item.value, classification: "ambiguous_url", reason: item.kind === "managed_path_note" ? "managed_note_unverified" : "invalid_structured_attachment" });
    } else anomalies.push({ code: "invalid_event_candidate", subject: source.source_pk, message: "unsupported event candidate" });
  }
  return targets;
}

function directRef(source: LegacySource, kind: "attachment_id" | "output_descriptor", pointer: string, id: string | undefined, assets: ReadonlyMap<string, InventoryAssetSnapshot>): InventoryDirectReference {
  const asset = id ? assets.get(id) : undefined;
  return { kind, source_kind: source.source_kind, source_table: source.source_table, source_pk: source.source_pk, pointer,
    ...(id ? { attachment_id: id } : {}), ...(asset ? { resolved_asset_id: asset.id, storage_purpose: asset.storage_purpose, upload_status: asset.upload_status,
      storage_verified: asset.storage_verified } : {}) };
}

function addBoardAsset(source: LegacySource, direct: InventoryDirectReference[], assets: ReadonlyMap<string, InventoryAssetSnapshot>): InventoryDirectReference | undefined {
  if (source.data.item_type !== "asset") return undefined;
  const id = text(source.data.item_id);
  const asset = assets.get(id);
  direct.push({ kind: "board_asset", source_kind: "existing_asset", source_table: "board_items", source_pk: source.source_pk,
    pointer: "/item_id", ...(id ? { attachment_id: id } : {}), ...(asset ? { resolved_asset_id: asset.id, storage_purpose: asset.storage_purpose,
      upload_status: asset.upload_status, storage_verified: asset.storage_verified } : {}), changed_after_cutoff: source.changed_after_cutoff });
  return direct[direct.length - 1];
}

function getOwner(source: LegacySource): InventoryOwnerEvidence {
  const kind = source.data.owner_kind;
  const rawKey = source.data.owner_key;
  if ((kind === "user_email" || kind === "agent_session") && typeof rawKey === "string" && rawKey.trim()) {
    return { status: "verified", kind, key: kind === "user_email" ? rawKey.trim().toLowerCase() : rawKey,
      scope: source.data.registration_scope ?? null, source: `${source.source_table}:${source.source_pk}` };
  }
  return { status: "unverified", reason: "explicit owner and scope evidence is absent", source: `${source.source_table}:${source.source_pk}` };
}

function groupTargets(values: readonly Occurrence[]): Group[] {
  const grouped = new Map<string, Group>();
  for (const value of values) {
    const ref: InventoryPlanReference = {
      source_kind: value.source.source_kind, source_table: value.source.source_table, source_pk: value.source.source_pk,
      pointer: value.target.pointer, ...(value.target.body_offset === undefined ? {} : { body_offset: value.target.body_offset }),
      ...(value.source.card_id === undefined ? {} : { card_id: value.source.card_id }),
      ...(value.source.session_id === undefined ? {} : { session_id: value.source.session_id }),
      ...(value.source.source_kind === "message" && typeof value.source.data.event_id === "number" ? { event_id: value.source.data.event_id } : {}),
      ...(value.source.source_kind === "item_history" ? { operation_id: value.source.source_pk } : {}),
      ...(value.target.raw_url ? { raw_url: value.target.raw_url } : {}), ...(value.target.raw_path ? { raw_path: value.target.raw_path } : {}),
      changed_after_cutoff: value.source.changed_after_cutoff, owner: value.owner,
    };
    const key = locKey(value.node, value.path);
    const group = grouped.get(key) ?? { node: value.node, path: value.path, owner: value.owner, ownerConflict: false, refs: [] };
    group.refs.push(ref);
    group.owner = mergeOwners(group.refs.map((item) => item.owner));
    group.ownerConflict = hasConflictingOwners(group.refs.map((item) => item.owner));
    grouped.set(key, group);
  }
  return [...grouped.values()];
}

function hasConflictingOwners(values: readonly InventoryOwnerEvidence[]): boolean {
  return new Set(values.filter((value) => value.status === "verified")
    .map((value) => stable({ kind: value.kind, key: value.key }))).size > 1;
}

function censusRootsCompletedExceptForExplicitAbsences(values: readonly NodeInput[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const value of values) {
    if (value.record_type !== "summary" || value.coverage_complete || value.error_code || !value.incoming_root ||
        value.incoming_census_complete !== true || (value.status_counts[FILE.source_absent] ?? 0) === 0) continue;
    result.set(value.node_id, value.incoming_root);
  }
  return result;
}

function samePhysicalPath(left: string, right: string): boolean {
  const leftFlavor = physicalPathFlavor(left);
  const rightFlavor = physicalPathFlavor(right);
  if (leftFlavor === undefined || leftFlavor !== rightFlavor) return false;
  return normalizePhysicalPath(left, leftFlavor) === normalizePhysicalPath(right, rightFlavor);
}

function pathIsWithin(root: string, candidate: string): boolean {
  const flavor = physicalPathFlavor(root);
  if (flavor === undefined || physicalPathFlavor(candidate) !== flavor) return false;
  const rootPath = normalizePhysicalPath(root, flavor);
  const candidatePath = normalizePhysicalPath(candidate, flavor);
  const relative = flavor === "windows" ? path.win32.relative(rootPath, candidatePath) : path.posix.relative(rootPath, candidatePath);
  const separator = flavor === "windows" ? "\\" : "/";
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${separator}`) && !relative.startsWith(separator));
}

function physicalPathFlavor(value: string): "windows" | "posix" | undefined {
  if (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value) || /^\/\/[^/]+\/[^/]+/.test(value)) return "windows";
  return value.startsWith("/") ? "posix" : undefined;
}

function normalizePhysicalPath(value: string, flavor: "windows" | "posix"): string {
  return flavor === "windows" ? path.win32.normalize(value).toLowerCase() : path.posix.normalize(value);
}

function matchesFile(file: FileObservation, group: Pick<Group, "node" | "path">): boolean {
  if (file.node_id !== group.node) return false;
  const namedPaths = [...file.known_source_paths, file.incoming_relative_path ?? ""];
  if (namedPaths.some((value) => value !== "" && normalizeAttachmentLegacyPath(value) === group.path)) return true;
  if (file.known_source_paths.length > 0) return false;
  return file.physical_path !== undefined && samePhysicalPath(file.physical_path, group.path);
}

function mergeOwners(values: readonly InventoryOwnerEvidence[]): InventoryOwnerEvidence {
  const verified = values.filter((value) => value.status === "verified");
  const keys = new Set(verified.map((value) => stable({ kind: value.kind, key: value.key })));
  const source = [...new Set(values.map((value) => value.source))].join(",");
  if (keys.size > 1) return { status: "unverified", reason: "conflicting owner provenance for the same legacy location", source };
  if (verified.length === values.length && keys.size === 1) {
    const scopes = new Set(verified.map((value) => stable(value.scope)));
    if (scopes.size === 1) return { ...verified[0]!, source };
    return { status: "unverified", reason: "owner scope provenance differs across references", source };
  }
  return { status: "unverified", reason: "owner provenance is missing for one or more references", source };
}

function resolve(group: Group, file: FileObservation | undefined, alias: InventoryAliasSnapshot | undefined, asset: InventoryAssetSnapshot | undefined,
  node: InventoryNodeCoverage | undefined, aliasCoverage: boolean, completedCensusRoot?: string, unreferenced = false):
  { status: InventoryPlanIdentity["status"]; coverage: boolean; action: string; proposed: boolean; error?: string } {
  if (alias?.availability === "missing") return { status: STATUS.existing_alias_missing, coverage: false, action: "recheck_missing_alias_and_preservation_locations", proposed: false };
  if (alias?.availability === "resolved") {
    if (!asset || asset.storage_purpose !== "attachment" || asset.garbage_collected_at) return { status: STATUS.alias_conflict, coverage: false, action: "resolve_alias_conflict", proposed: false, error: ERROR.alias_conflict };
    if (asset.upload_status !== "committed") return { status: STATUS.pending_or_temporary, coverage: false, action: "wait_for_existing_asset", proposed: false };
    if (!asset.storage_verified) return { status: STATUS.existing_alias_unverified, coverage: false, action: "verify_existing_storage_read_only", proposed: false };
    return { status: STATUS.already_migrated, coverage: true, action: "reuse_existing_alias_and_asset", proposed: false };
  }
  if (!aliasCoverage) return { status: STATUS.unconfirmed_path, coverage: false, action: "wait_for_alias_snapshot", proposed: false, error: ERROR.manifest_mismatch };
  if (file?.after_cutoff || file?.status === FILE.after_cutoff) return { status: STATUS.after_cutoff, coverage: true, action: "exclude_from_cutoff", proposed: false };
  if (file?.status === FILE.unstable || file?.status === FILE.hash_interrupted) return { status: STATUS.unstable, coverage: false, action: "reobserve_source", proposed: false };
  if (file?.status === FILE.path_denied) return { status: STATUS.denied_path, coverage: false, action: "resolve_path_boundary", proposed: false };
  if (file?.status === FILE.not_regular) return { status: STATUS.not_regular, coverage: false, action: "inspect_non_regular_source", proposed: false };
  if (file?.status === FILE.source_absent) return { status: STATUS.absent_at_source, coverage: false, action: "check_preservation_locations", proposed: false };
  if (!file) return (node?.status === NODE.scanned && node.coverage_complete) ||
      (completedCensusRoot !== undefined && pathIsWithin(completedCensusRoot, group.path))
    ? { status: STATUS.absent_at_source, coverage: false, action: "check_preservation_locations", proposed: false }
    : { status: STATUS.unconfirmed_node, coverage: false, action: "wait_for_node_scan", proposed: false };
  if (file.status !== FILE.observed || !file.eligible_candidate || !file.coverage_complete) return { status: STATUS.unconfirmed_path, coverage: false, action: "resolve_observation", proposed: false };
  if (unreferenced) return { status: STATUS.unreferenced_preservation_candidate, coverage: true, action: "preserve_without_references", proposed: false };
  if (group.owner.status !== "verified") return group.ownerConflict
    ? { status: STATUS.owner_unverified, coverage: false, action: "resolve_conflicting_owner_provenance", proposed: false, error: ERROR.owner_unverified }
    : { status: STATUS.owner_unverified, coverage: true, action: "propose_private_attachment_asset_and_alias", proposed: true };
  return { status: STATUS.verified_source, coverage: true, action: "propose_attachment_asset_and_alias", proposed: true };
}

function makeIdentity(group: Group, file: FileObservation | undefined, alias: InventoryAliasSnapshot | undefined, asset: InventoryAssetSnapshot | undefined,
  resolved: ReturnType<typeof resolve>, unreferenced = false): InventoryPlanIdentity {
  const name = path.posix.basename(group.path.replace(/\\/g, "/"));
  const identity = planId(group.node, group.path);
  return { identity_key: identity, legacy_node_id: group.node, normalized_path: group.path, name: name === "." ? "" : name,
    declared_mime: asset?.mime_type ?? null, inferred_mime: MIME[path.posix.extname(name).toLowerCase()] ?? "application/octet-stream",
    owner: group.owner, status: resolved.status, references: group.refs, source_occurrence_count: group.refs.length, unreferenced_incoming: unreferenced,
    ...(file?.physical_path ? { physical_path: file.physical_path } : {}), ...(file?.size_bytes === undefined ? {} : { size_bytes: file.size_bytes }),
    ...(file?.sha256 ? { sha256: file.sha256 } : {}), ...(file?.mtime ? { mtime: file.mtime } : {}), after_cutoff: file?.after_cutoff ?? false,
    stat_before: file ? { size_bytes: file.size_bytes ?? null, mtime_ms: file.mtime_ms ?? null } : null,
    stat_after: file && (file.status === FILE.observed || file.status === FILE.after_cutoff)
      ? { size_bytes: file.size_bytes ?? null, mtime_ms: file.mtime_ms ?? null } : null,
    coverage_complete: resolved.coverage && group.refs.every((ref) => !ref.changed_after_cutoff), ...(asset ? { existing_asset_id: asset.id } : {}),
    ...(alias ? { existing_alias: alias } : {}), ...(resolved.proposed ? { proposed_asset_id: identity,
      proposed_owner: group.owner.status === "verified" ? { kind: group.owner.kind, key: group.owner.key, scope: group.owner.scope } : null } : {}),
    proposed_ref_action: resolved.action };
}

function checkAnomalies(assets: readonly InventoryAssetSnapshot[], files: readonly FileObservation[], identities: readonly InventoryPlanIdentity[], output: InventoryPlanAnomaly[]): void {
  for (const asset of assets) {
    const name = asset.original_name ?? "";
    if (!name.trim()) output.push({ code: "empty_name", subject: asset.id, message: "filename is empty" });
    if (/[\\/]/.test(name)) output.push({ code: "path_separator_in_name", subject: asset.id, message: "filename contains a path separator" });
    if (/[\u0000-\u001f\u007f]/.test(name)) output.push({ code: "control_character_in_name", subject: asset.id, message: "filename contains a control character" });
    mimeAnomaly(name, asset.mime_type ?? null, asset.id, output);
    if (asset.byte_size === 0) output.push({ code: "zero_byte_file", subject: asset.id, message: "file is empty" });
    if (typeof asset.byte_size === "number" && asset.byte_size > MAX_BYTES) output.push({ code: "over_100_mib", subject: asset.id, message: "file exceeds 100 MiB" });
  }
  for (const file of files) {
    if (file.status === FILE.not_regular) output.push({ code: "not_regular_file", subject: file.physical_path ?? file.node_id, message: "path is not a regular file" });
    if (file.size_bytes === 0) output.push({ code: "zero_byte_file", subject: file.physical_path ?? file.node_id, message: "file is empty" });
    if (typeof file.size_bytes === "number" && file.size_bytes > MAX_BYTES) output.push({ code: "over_100_mib", subject: file.physical_path ?? file.node_id, message: "file exceeds 100 MiB" });
  }
  const names = new Map<string, Set<string>>();
  for (const item of identities) {
    if (!item.name.trim()) output.push({ code: "empty_name", subject: item.identity_key, message: "legacy filename is empty" });
    if (/[\\/]/.test(item.name)) output.push({ code: "path_separator_in_name", subject: item.identity_key, message: "legacy filename contains a path separator" });
    if (/[\u0000-\u001f\u007f]/.test(item.name)) output.push({ code: "control_character_in_name", subject: item.identity_key, message: "legacy filename contains a control character" });
    mimeAnomaly(item.name, item.declared_mime, item.identity_key, output);
    const key = item.name.toLowerCase();
    const ids = names.get(key) ?? new Set<string>();
    ids.add(item.identity_key);
    names.set(key, ids);
  }
  for (const [name, ids] of names) if (name && ids.size > 1) output.push({ code: "name_collision", subject: name, message: "filename is shared by different identities" });
}

function mimeAnomaly(name: string, declared: string | null, subject: string, output: InventoryPlanAnomaly[]): void {
  if (!declared?.trim()) { output.push({ code: "declared_mime_missing", subject, message: "declared MIME is unavailable" }); return; }
  const inferred = MIME[path.posix.extname(name).toLowerCase()];
  if (!inferred) output.push({ code: "unknown_mime", subject, message: "file extension has no MIME mapping" });
  else if (declared.split(";", 1)[0]!.trim().toLowerCase() !== inferred) output.push({ code: "mime_mismatch", subject, message: `declared MIME differs from ${inferred}` });
}

function summarize(metadata: InventoryRunBundleMetadata, complete: boolean, identities: InventoryPlanIdentity[], files: readonly FileObservation[], nodes: InventoryNodeCoverage[],
  sessions: InventorySessionCoverage[], direct: InventoryDirectReference[], ambiguousCount: number, assets: readonly InventoryAssetSnapshot[], anomalies: InventoryPlanAnomaly[], errors: string[], timings: InventoryPlan["stage_timings"]): InventoryPlanSummary {
  const found = new Map<string, FileObservation>();
  for (const file of files) found.set(`${file.node_id}\u0000${file.physical_path ?? file.incoming_relative_path ?? file.status}`, file);
  const observations = [...found.values()];
  const sized = observations.filter((file) => typeof file.size_bytes === "number");
  const verified = observations.filter((file) => file.status === FILE.observed && file.sha256 !== undefined);
  const unknownIdentitySizes = identities.filter((item) => item.size_bytes === undefined &&
    !observations.some((file) => matchesFile(file, { node: item.legacy_node_id, path: item.normalized_path }))).length;
  const unconfirmed = [
    ...nodes.filter((node) => !node.coverage_complete).map((node) => ({ subject: node.node_id, status: node.status, reason: node.error_code })),
    ...sessions.filter((row) => !row.coverage_complete).map((row) => ({ subject: row.session_id, status: row.state, reason: row.error_code })),
    ...metadata.event_session_ids.filter((id) => !sessions.some((row) => row.session_id === id)).map((id) => ({ subject: id, status: "not_reported", reason: ERROR.manifest_mismatch })),
    ...identities.filter((item) => item.status !== STATUS.unreferenced_preservation_candidate &&
      !(item.proposed_asset_id !== undefined && item.proposed_owner === null) && !item.coverage_complete)
      .map((item) => ({ subject: `${item.legacy_node_id}:${item.normalized_path}`, status: item.status })),
  ];
  const sourceRefs: Record<string, number> = {};
  for (const item of identities) for (const ref of item.references) sourceRefs[ref.source_kind] = (sourceRefs[ref.source_kind] ?? 0) + 1;
  for (const ref of direct) sourceRefs[ref.source_kind] = (sourceRefs[ref.source_kind] ?? 0) + 1;
  const duplicate = new Map<string, { size: number; count: number }>();
  for (const item of identities) if (item.sha256) {
    const key = `${item.sha256}:${item.size_bytes ?? "?"}`;
    const row = duplicate.get(key) ?? { size: item.size_bytes ?? 0, count: 0 };
    row.count += 1;
    duplicate.set(key, row);
  }
  const duplicateGroups = [...duplicate.values()].filter((item) => item.count > 1);
  const proposed = identities.filter((item) => item.proposed_asset_id !== undefined);
  const preservationTargets = identities.filter((item) => item.proposed_asset_id !== undefined || item.status === STATUS.unreferenced_preservation_candidate);
  const preservationUnknownCount = preservationTargets.filter((item) => item.size_bytes === undefined).length;
  const preservationBytes = preservationTargets.reduce((sum, item) => sum + (item.size_bytes ?? 0), 0);
  const messageRefs = proposed.reduce((sum, item) => sum + item.references.filter((ref) => ref.source_kind === "message").length, 0);
  const cardRefs = proposed.reduce((sum, item) => sum + item.references.filter((ref) => CARD_REFERENCE_KINDS.has(ref.source_kind)).length, 0);
  const nodeSummary = nodes.map((node) => {
    const related = files.filter((file) => file.node_id === node.node_id);
    const scanned = node.status === NODE.scanned && node.coverage_complete;
    return { node_id: node.node_id, status: node.status, coverage_complete: node.coverage_complete, file_count: scanned ? related.length : null,
      bytes: scanned ? related.reduce((sum, file) => sum + (file.bytes_read ?? 0), 0) : null,
      hash_coverage: scanned ? related.length ? related.filter((file) => file.sha256 !== undefined).length / related.length : 1 : null };
  });
  return {
    marker: INVENTORY_PLAN_MARKER, schema_version: INVENTORY_SCHEMA_VERSION, scan_id: metadata.scan_id, baseline_sha: metadata.baseline_sha,
    cutoff: parseInventoryCutoff(metadata.cutoff), observed_at: new Date().toISOString(), dry_run: true, writes_enabled: false,
    db_mutation_count: 0, r2_put_count: 0, coverage_complete: complete, exit_code: complete ? 0 : 2, planning_errors: errors,
    reference_occurrences: identities.reduce((sum, item) => sum + item.references.length, 0) + direct.length + ambiguousCount,
    distinct_legacy_identities: identities.length, discovered_files: observations.length,
    referenced_files: identities.filter((item) => !item.unreferenced_incoming).length, unreferenced_files: identities.filter((item) => item.unreferenced_incoming).length,
    verified_source_count: verified.length, verified_source_bytes: verified.reduce((sum, file) => sum + (file.size_bytes ?? 0), 0),
    known_size_total: sized.reduce((sum, file) => sum + (file.size_bytes ?? 0), 0), unknown_size_count: observations.length - sized.length + unknownIdentitySizes,
    confirmed_missing_count: identities.filter((item) => item.status === STATUS.confirmed_missing).length, unconfirmed_count: unconfirmed.length, unconfirmed,
    nodes: nodeSummary, source_refs: sourceRefs, duplicate_byte_groups: duplicateGroups.length,
    duplicate_byte_total_bytes: duplicateGroups.reduce((sum, item) => sum + item.size * (item.count - 1), 0),
    expected_copy_bytes: preservationBytes,
    expected_copy_unknown_count: preservationUnknownCount,
    preservation_target_count: preservationTargets.length,
    preservation_target_bytes: preservationBytes,
    preservation_target_unknown_count: preservationUnknownCount,
    ref_connectable_message_count: messageRefs,
    ref_connectable_card_count: cardRefs,
    owner_null_proposal_count: proposed.filter((item) => item.proposed_owner === null).length,
    proposed_assets: proposed.length, proposed_aliases: proposed.length,
    proposed_message_refs: messageRefs,
    proposed_card_refs: cardRefs,
    already_migrated: identities.filter((item) => item.status === STATUS.already_migrated).length,
    pending_or_temporary: assets.filter((asset) => asset.upload_status === "pending").length,
    existing_asset_count: assets.length, existing_board_asset_count: direct.filter((item) => item.kind === "board_asset").length,
    excluded: identities.filter((item) => item.status === STATUS.after_cutoff || item.status === STATUS.denied_path || item.status === STATUS.not_regular).length,
    anomaly_count: anomalies.length, stage_timings: timings,
  };
}

function planId(node: string, pathValue: string): string {
  return `legacy_${createHash("sha256").update(stable([node, pathValue])).digest("hex").slice(0, 24)}`;
}

function locKey(node: string, pathValue: string): string { return `${node}\u0000${pathValue}`; }
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function maybeText(value: unknown): string | null { return typeof value === "string" ? value : null; }
function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value) ?? "null";
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}
