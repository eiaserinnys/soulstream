import type {
  BoardItemType,
  ContainerItemRecord,
} from "../session_db_types.js";
import {
  toCatalogBoardItemRow,
  toIsoString,
} from "./repository_helpers.js";

export function toContainerItemRecord(row: ContainerItemDbRow): ContainerItemRecord {
  const boardItem = toCatalogBoardItemRow({
    id: row.bi_id!,
    folder_id: row.bi_folder_id!,
    container_kind: row.bi_container_kind,
    container_id: row.bi_container_id,
    membership_kind: row.bi_membership_kind,
    source_runbook_item_id: row.bi_source_runbook_item_id,
    item_type: row.bi_item_type!,
    item_id: row.bi_item_id!,
    x: row.bi_x!,
    y: row.bi_y!,
    metadata: row.bi_metadata,
    created_at: row.bi_created_at ?? null,
    updated_at: row.bi_updated_at ?? null,
  });
  const result: ContainerItemRecord = {
    boardItem,
    archived: Boolean(row.item_archived),
  };
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
  if (boardItem.itemType === "runbook" && row.runbook_id) {
    result.runbook = titleRecord(row.runbook_id, row.runbook_title, row.runbook_updated_at);
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
  return { id, title: title ?? null, updatedAt: toIsoString(updatedAt ?? null) ?? null };
}

function nullableNumber(value: string | number | null | undefined): number | null {
  return value == null ? null : Number(value);
}

export interface ContainerItemDbRow {
  bi_id: string | null;
  bi_folder_id?: string;
  bi_container_kind?: "folder" | "runbook";
  bi_container_id?: string;
  bi_membership_kind?: "primary" | "reference";
  bi_source_runbook_item_id?: string | null;
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
  runbook_id?: string | null;
  runbook_title?: string | null;
  runbook_updated_at?: Date | string | null;
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
  runbook_count?: string | number;
  custom_view_count?: string | number;
}
