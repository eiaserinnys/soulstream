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

export const INVENTORY_STAGE_NAMES = ["relational", "events", "node_scan", "plan"] as const;

export type InventoryStageName = (typeof INVENTORY_STAGE_NAMES)[number];
export type InventoryStageTiming = { started_at: string; ended_at: string };
export type InventoryRunMetadata = {
  schema_version: typeof INVENTORY_SCHEMA_VERSION;
  cutoff: string;
  stages: Partial<Record<InventoryStageName, InventoryStageTiming>>;
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
