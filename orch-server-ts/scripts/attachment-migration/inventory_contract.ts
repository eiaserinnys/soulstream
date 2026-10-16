export const INVENTORY_SCHEMA_VERSION = 1 as const;
export const RELATIONAL_SOURCES_EXPORTED = "RELATIONAL_SOURCES_EXPORTED" as const;
export const EVENTS_EXPORTED = "EVENTS_EXPORTED" as const;
export const NODE_INVENTORY_RECORDED = "NODE_INVENTORY_RECORDED" as const;

export const INVENTORY_ERROR_CODES = Object.freeze({
  invalid_source: "INVENTORY_INVALID_SOURCE",
  event_shape_invalid: "INVENTORY_EVENT_SHAPE_INVALID",
  source_changed: "INVENTORY_SOURCE_CHANGED",
  query_timeout: "INVENTORY_QUERY_TIMEOUT",
  root_unconfirmed: "INVENTORY_ROOT_UNCONFIRMED",
  path_denied: "INVENTORY_PATH_DENIED",
  not_regular: "INVENTORY_NOT_REGULAR",
  source_absent: "INVENTORY_SOURCE_ABSENT",
  file_changed: "INVENTORY_FILE_CHANGED",
  hash_interrupted: "INVENTORY_HASH_INTERRUPTED",
  manifest_mismatch: "INVENTORY_MANIFEST_MISMATCH",
  alias_conflict: "INVENTORY_ALIAS_CONFLICT",
  owner_unverified: "INVENTORY_OWNER_UNVERIFIED",
  output_failed: "INVENTORY_OUTPUT_FAILED",
} as const);

export const FILE_OBSERVATION_STATUS = Object.freeze({
  observed: "observed",
  after_cutoff: "after_cutoff",
  unstable: "unstable",
  path_denied: "path_denied",
  not_regular: "not_regular",
  source_absent: "source_absent",
  root_unconfirmed: "root_unconfirmed",
  hash_interrupted: "hash_interrupted",
} as const);

export const INVENTORY_EVENT_TYPES = ["user_message", "intervention_sent", "complete", "assistant_message"] as const;
export const INVENTORY_EVENT_PROGRESS_STATE = Object.freeze({
  page: "page",
  complete: "complete",
  source_changed: "source_changed",
} as const);

export const INVENTORY_CUTOFF_POLICY = Object.freeze({
  relational_created_at: "less_than_or_equal",
  events_created_at: "less_than_or_equal",
  updated_after_cutoff: "include_and_mark_changed_after_cutoff",
  file_mtime_after_cutoff: "hash_and_classify_after_cutoff",
} as const);

export const INVENTORY_PLAN_MARKER = "ATTACHMENT_MIGRATION_DRY_RUN" as const;
export const INVENTORY_PLAN_STATUS = Object.freeze({
  verified_source: "verified_source",
  unconfirmed_node: "unconfirmed_node",
  unconfirmed_path: "unconfirmed_path",
  denied_path: "denied_path",
  not_regular: "not_regular",
  absent_at_source: "absent_at_source",
  confirmed_missing: "confirmed_missing",
  unstable: "unstable",
  after_cutoff: "after_cutoff",
  already_migrated: "already_migrated",
  existing_alias_unverified: "existing_alias_unverified",
  existing_alias_missing: "existing_alias_missing",
  pending_or_temporary: "pending_or_temporary",
  alias_conflict: "alias_conflict",
  owner_unverified: "owner_unverified",
} as const);

export const INVENTORY_NODE_COVERAGE_STATUS = Object.freeze({
  scanned: "scanned",
  offline: "offline",
  registry_missing: "registry_missing",
  http_502: "http_502",
  timeout: "timeout",
  partial: "partial",
  not_reported: "not_reported",
} as const);

export const INVENTORY_STAGE_NAMES = ["relational", "events", "node_scan", "plan"] as const;

export type InventoryStageName = (typeof INVENTORY_STAGE_NAMES)[number];
export type InventoryStageTiming = { started_at: string; ended_at: string };
export type InventoryRunMetadata = {
  schema_version: typeof INVENTORY_SCHEMA_VERSION;
  cutoff: string;
  stages: Partial<Record<InventoryStageName, InventoryStageTiming>>;
};

export type InventoryRunBundleMetadata = {
  record_type: "run_metadata";
  schema_version: typeof INVENTORY_SCHEMA_VERSION;
  scan_id: string;
  baseline_sha: string;
  cutoff: string;
  expected_node_ids: string[];
  relational_coverage_complete: boolean;
  event_session_ids: string[];
  alias_snapshot_complete: boolean;
  stages: Partial<Record<InventoryStageName, InventoryStageTiming>>;
};

export type InventorySessionCoverage = {
  record_type: "session_coverage";
  schema_version: typeof INVENTORY_SCHEMA_VERSION;
  session_id: string;
  state: (typeof INVENTORY_EVENT_PROGRESS_STATE)[keyof typeof INVENTORY_EVENT_PROGRESS_STATE];
  cursor: EventExtractionCursor;
  coverage_complete: boolean;
  started_at: string;
  observed_at: string;
  ended_at?: string;
  error_code?: (typeof INVENTORY_ERROR_CODES)[keyof typeof INVENTORY_ERROR_CODES];
};

export type InventoryAliasSnapshot = {
  record_type?: "alias";
  node_id: string;
  normalized_path: string;
  asset_id: string | null;
  original_path: string;
  availability: "resolved" | "missing";
  checked_at: string;
};

export type InventoryAssetSnapshot = {
  record_type?: "asset";
  id: string;
  storage_purpose: "attachment" | "board" | string;
  storage_key?: string | null;
  storage_endpoint?: string | null;
  storage_bucket?: string | null;
  upload_status: "pending" | "committed" | string;
  original_name?: string | null;
  mime_type?: string | null;
  byte_size?: number | null;
  checksum_sha256?: string | null;
  garbage_collected_at?: string | null;
  owner_kind?: string | null;
  owner_key?: string | null;
  registration_scope?: unknown;
  storage_verified?: boolean;
  changed_after_cutoff?: boolean;
};

export type InventoryNodeCoverage = {
  record_type: "node_coverage";
  schema_version: typeof INVENTORY_SCHEMA_VERSION;
  node_id: string;
  status: (typeof INVENTORY_NODE_COVERAGE_STATUS)[keyof typeof INVENTORY_NODE_COVERAGE_STATUS];
  coverage_complete: boolean;
  observed_at: string;
  error_code?: (typeof INVENTORY_ERROR_CODES)[keyof typeof INVENTORY_ERROR_CODES];
};

export type InventoryOwnerEvidence =
  | { status: "verified"; kind: "user_email" | "agent_session"; key: string; scope: unknown; source: string }
  | { status: "unverified"; reason: string; source: string };

export type InventoryPlanReference = {
  source_kind: LegacySourceKind;
  source_table: RelationalSourceTable;
  source_pk: string;
  pointer: string;
  body_offset?: number;
  card_id?: string | null;
  session_id?: string | null;
  event_id?: number;
  operation_id?: string;
  raw_url?: string;
  raw_path?: string;
  changed_after_cutoff: boolean;
  owner: InventoryOwnerEvidence;
};

export type InventoryPlanIdentity = {
  identity_key: string;
  legacy_node_id: string;
  normalized_path: string;
  name: string;
  declared_mime: string | null;
  inferred_mime: string;
  owner: InventoryOwnerEvidence;
  status: (typeof INVENTORY_PLAN_STATUS)[keyof typeof INVENTORY_PLAN_STATUS];
  references: InventoryPlanReference[];
  source_occurrence_count: number;
  unreferenced_incoming: boolean;
  physical_path?: string;
  size_bytes?: number;
  sha256?: string;
  mtime?: string;
  stat_before: { size_bytes: number | null; mtime_ms: number | null } | null;
  stat_after: { size_bytes: number | null; mtime_ms: number | null } | null;
  after_cutoff: boolean;
  coverage_complete: boolean;
  existing_asset_id?: string;
  existing_alias?: InventoryAliasSnapshot;
  proposed_asset_id?: string;
  proposed_ref_action: string;
};

export type InventoryPlanAnomaly = {
  code: string;
  subject: string;
  message: string;
  source?: string;
};

export type InventoryDirectReference = {
  kind: "attachment_id" | "output_descriptor" | "board_asset";
  source_kind: LegacySourceKind;
  source_table: RelationalSourceTable;
  source_pk: string;
  pointer: string;
  attachment_id?: string;
  name?: string;
  mime_type?: string;
  resolved_asset_id?: string;
  storage_purpose?: string;
  upload_status?: string;
  storage_verified?: boolean;
  changed_after_cutoff?: boolean;
};

export type InventoryPlanSummary = {
  marker: typeof INVENTORY_PLAN_MARKER;
  schema_version: typeof INVENTORY_SCHEMA_VERSION;
  scan_id: string;
  baseline_sha: string;
  cutoff: string;
  observed_at: string;
  dry_run: true;
  writes_enabled: false;
  db_mutation_count: 0;
  r2_put_count: 0;
  coverage_complete: boolean;
  exit_code: 0 | 2;
  planning_errors: string[];
  reference_occurrences: number;
  distinct_legacy_identities: number;
  discovered_files: number;
  referenced_files: number;
  unreferenced_files: number;
  verified_source_count: number;
  verified_source_bytes: number;
  known_size_total: number;
  unknown_size_count: number;
  confirmed_missing_count: number;
  unconfirmed_count: number;
  unconfirmed: Array<{ subject: string; status: string; reason?: string }>;
  nodes: Array<{ node_id: string; status: string; coverage_complete: boolean; file_count: number | null; bytes: number | null; hash_coverage: number | null }>;
  source_refs: Record<string, number>;
  duplicate_byte_groups: number;
  duplicate_byte_total_bytes: number;
  expected_copy_bytes: number;
  expected_copy_unknown_count: number;
  proposed_assets: number;
  proposed_aliases: number;
  proposed_message_refs: number;
  proposed_card_refs: number;
  already_migrated: number;
  pending_or_temporary: number;
  existing_asset_count: number;
  existing_board_asset_count: number;
  excluded: number;
  anomaly_count: number;
  stage_timings: Partial<Record<InventoryStageName, InventoryStageTiming>>;
  output_checksums?: Record<string, string>;
  readback_verified?: boolean;
};

export type InventoryPlan = {
  metadata: InventoryRunBundleMetadata;
  stage_timings: Partial<Record<InventoryStageName, InventoryStageTiming>>;
  coverage_complete: boolean;
  identities: InventoryPlanIdentity[];
  direct_references: InventoryDirectReference[];
  ambiguous_targets: Array<{ source_pk: string; pointer: string; raw_url?: string; raw_path?: string; reason?: string }>;
  anomalies: InventoryPlanAnomaly[];
  node_coverage: InventoryNodeCoverage[];
  session_coverage: InventorySessionCoverage[];
  existing_assets: InventoryAssetSnapshot[];
  summary: InventoryPlanSummary;
};

export type RelationalSourceTable =
  | "cards"
  | "card_reports"
  | "card_comments"
  | "folder_operations"
  | "file_assets"
  | "board_items"
  | "events";

export type LegacySourceKind =
  | "card_request"
  | "card_item"
  | "report"
  | "comment"
  | "note"
  | "item_history"
  | "existing_asset"
  | "message";

export type EventExtractionCursor = { sessionId: string; eventId: number };
export type EventAttachmentCandidate = {
  pointer: string;
  kind: "input_path" | "attachment_id" | "output_descriptor" | "managed_path_note";
  value: string | Record<string, unknown>;
  verified?: boolean;
};
export type EventExtractionProgress = {
  session_id: string;
  state: (typeof INVENTORY_EVENT_PROGRESS_STATE)[keyof typeof INVENTORY_EVENT_PROGRESS_STATE];
  cursor: EventExtractionCursor;
  coverage_complete: boolean;
  started_at: string;
  observed_at: string;
  ended_at?: string;
  error_code?: (typeof INVENTORY_ERROR_CODES)[keyof typeof INVENTORY_ERROR_CODES];
};

export type FileSourceReference = {
  source_kind: LegacySourceKind;
  source_table: RelationalSourceTable;
  source_pk: string;
  source_pointer: string;
  session_id?: string | null;
  card_id?: string | null;
};

export type ExplicitFileSource = {
  node_id: string;
  path: string;
  physical_path?: string;
  source_ref: FileSourceReference;
};

export type FileObservationStatus = (typeof FILE_OBSERVATION_STATUS)[keyof typeof FILE_OBSERVATION_STATUS];
export type FileObservation = {
  record_type: "file";
  schema_version: typeof INVENTORY_SCHEMA_VERSION;
  node_id: string;
  status: FileObservationStatus;
  known_source_paths: string[];
  incoming_relative_path?: string;
  physical_path?: string;
  source_refs: FileSourceReference[];
  size_bytes?: number;
  bytes_read?: number;
  mtime_ms?: number;
  mtime?: string;
  sha256?: string;
  after_cutoff: boolean;
  eligible_candidate: boolean;
  coverage_complete: boolean;
  error_code?: (typeof INVENTORY_ERROR_CODES)[keyof typeof INVENTORY_ERROR_CODES];
};

export type NodeScanSummary = {
  record_type: "summary";
  schema_version: typeof INVENTORY_SCHEMA_VERSION;
  node_id: string;
  cutoff: string;
  started_at: string;
  ended_at: string;
  coverage_complete: boolean;
  file_count: number;
  bytes_hashed: number;
  hashes_completed: number;
  after_cutoff_count: number;
  status_counts: Partial<Record<FileObservationStatus, number>>;
  error_code?: (typeof INVENTORY_ERROR_CODES)[keyof typeof INVENTORY_ERROR_CODES];
};

export type NodeScanOutputRecord = FileObservation | NodeScanSummary;

export type LegacySource = {
  schema_version: typeof INVENTORY_SCHEMA_VERSION;
  source_kind: LegacySourceKind;
  source_table: RelationalSourceTable;
  source_pk: string;
  source_pointer: string;
  row_sha256: string;
  created_at: string;
  updated_at?: string;
  changed_after_cutoff: boolean;
  card_id?: string | null;
  session_id?: string | null;
  data: Record<string, unknown>;
};

export type LegacyTarget = {
  pointer: string;
  body_offset?: number;
  raw_url?: string;
  raw_path?: string;
  legacy_node_id?: string;
  normalized_path?: string;
  classification: "legacy_path" | "ambiguous_url";
  reason?:
    | "unknown_origin"
    | "unexpected_route"
    | "duplicate_query_parameter"
    | "missing_query_parameter"
    | "empty_query_parameter"
    | "managed_note_unverified"
    | "invalid_structured_attachment";
};

export type InventoryErrorCode =
  | "INVENTORY_INVALID_SOURCE"
  | "INVENTORY_AMBIGUOUS_URL"
  | "INVENTORY_DB_READ_FAILED"
  | (typeof INVENTORY_ERROR_CODES)[keyof typeof INVENTORY_ERROR_CODES];

export function parseInventoryCutoff(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) throw new TypeError("cutoff must be a UTC ISO timestamp ending in Z");
  const fraction = (match[2] ?? "").padEnd(3, "0");
  const canonical = `${match[1]}.${fraction}Z`;
  if (new Date(canonical).toISOString() !== canonical) throw new TypeError("cutoff must be a valid UTC ISO timestamp");
  return canonical;
}

export function inventoryError(code: InventoryErrorCode, message: string, cause?: unknown): Error & { code: InventoryErrorCode } {
  const error = Object.assign(new Error(message), { code });
  if (cause !== undefined) Object.defineProperty(error, "cause", { value: cause, enumerable: false });
  return error;
}
