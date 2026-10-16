export const INVENTORY_SCHEMA_VERSION = 1 as const;
export const RELATIONAL_SOURCES_EXPORTED = "RELATIONAL_SOURCES_EXPORTED" as const;

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
  | "board_items";

export type LegacySourceKind =
  | "card_request"
  | "card_item"
  | "report"
  | "comment"
  | "note"
  | "item_history"
  | "existing_asset";

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
  | "INVENTORY_DB_READ_FAILED";

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
