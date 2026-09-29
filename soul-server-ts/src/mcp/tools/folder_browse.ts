import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { FOLDER_SEARCH_SCAN_LIMIT, type FolderBrowseItem } from "../../catalog/folder_browse_service.js";
import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";

export function registerFolderSearchTools(server: McpServer, runtime: McpRuntime): void {
  server.registerTool("search_folder_items", {
    description: `한 폴더 안에서 최근 갱신된 최대 ${FOLDER_SEARCH_SCAN_LIMIT}개 세션과 마크다운의 표시명·제목·본문을 검색한다. truncated=true면 더 오래된 항목은 검색되지 않았다.`,
    inputSchema: {
      folder_id: z.string().min(1),
      query: z.string().min(1),
      limit: z.number().int().positive().default(20),
      include_archived: z.boolean().default(false),
    },
  }, async ({ folder_id, query, limit, include_archived }) => {
    try {
      const result = await runtime.catalogService.searchFolderItems({
        folderId: folder_id,
        query,
        limit,
        includeArchived: include_archived,
      });
      return jsonResult({
        folder_id: result.folderId,
        items: result.items.map((item) => serializeFolderItem(item, runtime)),
        page: {
          cursor: result.page.cursor,
          limit: result.page.limit,
          total: result.page.total,
          next_cursor: result.page.nextCursor,
        },
        counts: result.counts,
        ...(result.search ? {
          truncated: result.search.truncated,
          scanned_items: result.search.scannedItems,
          scan_limit: result.search.scanLimit,
        } : {}),
      });
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  });
}

export function serializeFolderItem(item: FolderBrowseItem, runtime: McpRuntime) {
  const base = {
    type: item.type,
    board_item_id: item.boardItemId,
    archived: item.archived,
    updated_at: item.updatedAt,
  };
  if (item.type === "session") {
    const agent = item.agentId ? runtime.agentRegistry.get(item.agentId) : undefined;
    return {
      ...base,
      agent_session_id: item.agentSessionId,
      display_name: item.displayName,
      status: item.status,
      agent: item.agentId
        ? { id: agent?.id ?? item.agentId, name: agent?.name ?? item.agentId }
        : null,
      session_type: item.sessionType,
      created_at: item.createdAt,
      event_count: item.eventCount,
      away_summary: item.awaySummary,
      caller_session_id: item.callerSessionId,
      predecessor_session_id: item.predecessorSessionId,
      node_id: item.nodeId,
      last_event_id: item.lastEventId,
      last_read_event_id: item.lastReadEventId,
    };
  }
  if (item.type === "markdown") {
    return { ...base, id: item.id, title: item.title, preview: item.preview };
  }
  return { ...base, id: item.id, title: item.title };
}
