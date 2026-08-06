import type {
  BoardItemType,
  CatalogBoardItemRow,
  MarkdownDocumentRow,
} from "./board_yjs_types.js";
import type {
  ContainerItemRecord,
  CustomViewRow,
  CustomViewWithBoardItem,
} from "./board_projection_types.js";

export interface BoardItemDbRow extends Record<string, unknown> {
  id: string;
  folder_id: string;
  container_kind?: "folder" | "task" | null;
  container_id?: string | null;
  membership_kind?: "primary" | "reference" | null;
  source_task_item_id?: string | null;
  item_type: BoardItemType;
  item_id: string;
  x: string | number;
  y: string | number;
  metadata: unknown;
  created_at: Date | string | null;
  updated_at: Date | string | null;
}

export interface MarkdownDbRow extends Record<string, unknown> {
  id: string;
  title: string;
  body: string;
  version: string | number | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
}

export interface CustomViewDbRow extends Record<string, unknown> {
  id: string;
  board_item_id: string;
  title: string | null;
  html: string;
  revision: string | number;
  archived: boolean;
  created_actor_kind: CustomViewRow["createdActorKind"];
  created_session_id: string | null;
  created_event_id: string | number | null;
  updated_actor_kind: CustomViewRow["updatedActorKind"];
  updated_session_id: string | null;
  updated_event_id: string | number | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
}

export interface CustomViewJoinRow extends Record<string, unknown> {
  cv_id: string;
  cv_board_item_id: string;
  cv_title: string | null;
  cv_html: string;
  cv_revision: string | number;
  cv_archived: boolean;
  cv_created_actor_kind: CustomViewRow["createdActorKind"];
  cv_created_session_id: string | null;
  cv_created_event_id: string | number | null;
  cv_updated_actor_kind: CustomViewRow["updatedActorKind"];
  cv_updated_session_id: string | null;
  cv_updated_event_id: string | number | null;
  cv_created_at: Date | string | null;
  cv_updated_at: Date | string | null;
  bi_id: string;
  bi_folder_id: string;
  bi_container_kind: "folder" | "task" | null;
  bi_container_id: string | null;
  bi_membership_kind: "primary" | "reference" | null;
  bi_source_task_item_id: string | null;
  bi_item_type: "custom_view";
  bi_item_id: string;
  bi_x: string | number;
  bi_y: string | number;
  bi_metadata: unknown;
  bi_created_at: Date | string | null;
  bi_updated_at: Date | string | null;
}

export interface ContainerItemDbRow extends Record<string, unknown> {
  bi_id: string | null;
  bi_folder_id?: string;
  bi_container_kind?: "folder" | "task";
  bi_container_id?: string;
  bi_membership_kind?: "primary" | "reference";
  bi_source_task_item_id?: string | null;
  bi_item_type?: BoardItemType;
  bi_item_id?: string;
  bi_x?: string | number;
  bi_y?: string | number;
  bi_metadata?: unknown;
  bi_created_at?: Date | string | null;
  bi_updated_at?: Date | string | null;
  item_archived?: boolean;
  session_display_name?: string | null;
  session_status?: string | null;
  session_type?: string | null;
  session_created_at?: Date | string | null;
  session_updated_at?: Date | string | null;
  session_event_count?: string | number | null;
  session_away_summary?: string | null;
  session_caller_session_id?: string | null;
  session_predecessor_session_id?: string | null;
  session_node_id?: string | null;
  session_agent_id?: string | null;
  session_last_event_id?: string | number | null;
  session_last_read_event_id?: string | number | null;
  session_last_user_preview?: string | null;
  markdown_id?: string | null;
  markdown_title?: string | null;
  markdown_body?: string | null;
  markdown_updated_at?: Date | string | null;
  task_id?: string | null;
  task_title?: string | null;
  task_updated_at?: Date | string | null;
  custom_view_id?: string | null;
  custom_view_title?: string | null;
  custom_view_updated_at?: Date | string | null;
  asset_id?: string | null;
  asset_title?: string | null;
  asset_updated_at?: Date | string | null;
  subfolder_id?: string | null;
  subfolder_title?: string | null;
  total_count?: string | number;
  session_count?: string | number;
  markdown_count?: string | number;
  subfolder_count?: string | number;
  asset_count?: string | number;
  frame_count?: string | number;
  task_count?: string | number;
  custom_view_count?: string | number;
  scanned_items?: string | number | null;
  search_truncated?: boolean | null;
}

export function toCatalogBoardItemRow(row: BoardItemDbRow): CatalogBoardItemRow {
  return {
    id: row.id,
    folderId: row.folder_id,
    containerKind: row.container_kind ?? "folder",
    containerId: row.container_id ?? row.folder_id,
    membershipKind: row.membership_kind ?? "primary",
    sourceTaskItemId: row.source_task_item_id ?? null,
    itemType: row.item_type,
    itemId: row.item_id,
    x: Number(row.x),
    y: Number(row.y),
    metadata: recordFromDb(row.metadata),
    ...(toIsoString(row.created_at) ? { createdAt: toIsoString(row.created_at) } : {}),
    ...(toIsoString(row.updated_at) ? { updatedAt: toIsoString(row.updated_at) } : {}),
  };
}

export function toMarkdownDocumentRow(row: MarkdownDbRow): MarkdownDocumentRow {
  const parsedVersion = Number(row.version);
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    version: Number.isFinite(parsedVersion) && parsedVersion >= 1
      ? Math.trunc(parsedVersion)
      : 1,
    ...(toIsoString(row.created_at) ? { createdAt: toIsoString(row.created_at) } : {}),
    ...(toIsoString(row.updated_at) ? { updatedAt: toIsoString(row.updated_at) } : {}),
  };
}

export function normalizeCustomViewRow(row: CustomViewDbRow): CustomViewRow {
  return {
    id: row.id,
    boardItemId: row.board_item_id,
    title: row.title,
    html: row.html,
    revision: Number(row.revision),
    archived: Boolean(row.archived),
    createdActorKind: row.created_actor_kind,
    createdSessionId: row.created_session_id,
    createdEventId: nullableNumber(row.created_event_id),
    updatedActorKind: row.updated_actor_kind,
    updatedSessionId: row.updated_session_id,
    updatedEventId: nullableNumber(row.updated_event_id),
    ...(toIsoString(row.created_at) ? { createdAt: toIsoString(row.created_at) } : {}),
    ...(toIsoString(row.updated_at) ? { updatedAt: toIsoString(row.updated_at) } : {}),
  };
}

export function normalizeCustomViewJoin(row: CustomViewJoinRow): CustomViewWithBoardItem {
  return {
    customView: normalizeCustomViewRow({
      id: row.cv_id,
      board_item_id: row.cv_board_item_id,
      title: row.cv_title,
      html: row.cv_html,
      revision: row.cv_revision,
      archived: row.cv_archived,
      created_actor_kind: row.cv_created_actor_kind,
      created_session_id: row.cv_created_session_id,
      created_event_id: row.cv_created_event_id,
      updated_actor_kind: row.cv_updated_actor_kind,
      updated_session_id: row.cv_updated_session_id,
      updated_event_id: row.cv_updated_event_id,
      created_at: row.cv_created_at,
      updated_at: row.cv_updated_at,
    }),
    boardItem: toCatalogBoardItemRow({
      id: row.bi_id,
      folder_id: row.bi_folder_id,
      container_kind: row.bi_container_kind,
      container_id: row.bi_container_id,
      membership_kind: row.bi_membership_kind,
      source_task_item_id: row.bi_source_task_item_id,
      item_type: row.bi_item_type,
      item_id: row.bi_item_id,
      x: row.bi_x,
      y: row.bi_y,
      metadata: row.bi_metadata,
      created_at: row.bi_created_at,
      updated_at: row.bi_updated_at,
    }),
  };
}

export function toContainerItemRecord(row: ContainerItemDbRow): ContainerItemRecord {
  const boardItem = toCatalogBoardItemRow({
    id: row.bi_id!,
    folder_id: row.bi_folder_id!,
    container_kind: row.bi_container_kind,
    container_id: row.bi_container_id,
    membership_kind: row.bi_membership_kind,
    source_task_item_id: row.bi_source_task_item_id,
    item_type: row.bi_item_type!,
    item_id: row.bi_item_id!,
    x: row.bi_x!,
    y: row.bi_y!,
    metadata: row.bi_metadata,
    created_at: row.bi_created_at ?? null,
    updated_at: row.bi_updated_at ?? null,
  });
  const result: ContainerItemRecord = { boardItem, archived: Boolean(row.item_archived) };
  if (boardItem.itemType === "session" && row.session_created_at && row.session_updated_at) {
    result.session = {
      agentSessionId: boardItem.itemId,
      displayName: row.session_display_name ?? null,
      lastUserMessagePreview: row.session_last_user_preview ?? null,
      status: row.session_status ?? null,
      agentId: row.session_agent_id ?? null,
      sessionType: row.session_type ?? null,
      createdAt: toIsoString(row.session_created_at)!,
      updatedAt: toIsoString(row.session_updated_at)!,
      eventCount: Number(row.session_event_count ?? 0),
      awaySummary: row.session_away_summary ?? null,
      callerSessionId: row.session_caller_session_id ?? null,
      predecessorSessionId: row.session_predecessor_session_id ?? null,
      nodeId: row.session_node_id ?? null,
      lastEventId: nullableNumber(row.session_last_event_id),
      lastReadEventId: nullableNumber(row.session_last_read_event_id),
    };
  }
  if (boardItem.itemType === "markdown" && row.markdown_id) {
    result.markdown = {
      id: row.markdown_id,
      title: row.markdown_title ?? "",
      body: row.markdown_body ?? "",
      updatedAt: toIsoString(row.markdown_updated_at) ?? null,
    };
  }
  if (boardItem.itemType === "task" && row.task_id) {
    result.task = titleRecord(row.task_id, row.task_title, row.task_updated_at);
  }
  if (boardItem.itemType === "custom_view" && row.custom_view_id) {
    result.customView = titleRecord(
      row.custom_view_id,
      row.custom_view_title,
      row.custom_view_updated_at,
    );
  }
  if (boardItem.itemType === "asset" && row.asset_id) {
    result.asset = titleRecord(row.asset_id, row.asset_title, row.asset_updated_at);
  }
  if (boardItem.itemType === "subfolder" && row.subfolder_id) {
    result.subfolder = { id: row.subfolder_id, title: row.subfolder_title ?? null };
  }
  return result;
}

function titleRecord(
  id: string,
  title: string | null | undefined,
  updatedAt: Date | string | null | undefined,
) {
  return { id, title: title ?? null, updatedAt: toIsoString(updatedAt) ?? null };
}

function recordFromDb(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nullableNumber(value: string | number | null | undefined): number | null {
  return value == null ? null : Number(value);
}

function toIsoString(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}
