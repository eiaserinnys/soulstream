import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  CONTAINER_SEARCH_SCAN_LIMIT,
  type ContainerBrowseItem,
} from "../../catalog/container_browse_service.js";
import { boardContainerKindInputSchema } from "../../collaboration/board_container_kind_compat.js";
import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";

const containerSchema = z.object({
  kind: boardContainerKindInputSchema,
  id: z.string().min(1),
});

export function registerContainerBrowseTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  server.registerTool(
    "browse_container",
    {
      description:
        "현재 업무 컨테이너의 형제 세션과 산출물을 조회한다. 세션 간 협업 대상을 찾거나 같은 폴더/업무의 문서·업무·커스텀뷰·파일을 열기 전에 사용한다. Codex 등 위임 세션은 caller_session_id에 자기 agent_session_id를 명시한다.",
      inputSchema: {
        container: containerSchema,
        caller_session_id: z.string().min(1).optional(),
        limit: z.number().int().positive().default(20),
        cursor: z.number().int().min(0).default(0),
        include_archived: z.boolean().default(false),
      },
    },
    async ({ container, limit, cursor, include_archived }) => {
      try {
        const result = await runtime.catalogService.browseContainer({
          container: {
            containerKind: container.kind,
            containerId: container.id,
          },
          limit,
          cursor,
          includeArchived: include_archived,
        });
        return jsonResult(serializeResult(result, runtime));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "search_container_items",
    {
      description:
        `한 폴더/업무 안에서만 최근 갱신된 최대 ${CONTAINER_SEARCH_SCAN_LIMIT}개 형제 세션·마크다운의 표시명·제목·본문을 검색한다. 응답의 truncated가 true면 더 오래된 항목은 검색하지 않았다는 뜻이다. 전역 세션 기록 검색에는 search_session_history를 사용한다. Codex 등 위임 세션은 caller_session_id에 자기 agent_session_id를 명시한다.`,
      inputSchema: {
        container: containerSchema,
        query: z.string().min(1),
        caller_session_id: z.string().min(1).optional(),
        limit: z.number().int().positive().default(20),
        include_archived: z.boolean().default(false),
      },
    },
    async ({ container, query, limit, include_archived }) => {
      try {
        const result = await runtime.catalogService.searchContainerItems({
          container: {
            containerKind: container.kind,
            containerId: container.id,
          },
          query,
          limit,
          includeArchived: include_archived,
        });
        return jsonResult(serializeResult(result, runtime));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

function serializeResult(
  result: Awaited<ReturnType<McpRuntime["catalogService"]["browseContainer"]>>,
  runtime: McpRuntime,
) {
  return {
    container: {
      kind: result.container.containerKind,
      id: result.container.containerId,
    },
    items: result.items.map((item) => serializeItem(item, runtime)),
    page: {
      cursor: result.page.cursor,
      limit: result.page.limit,
      total: result.page.total,
      next_cursor: result.page.nextCursor,
    },
    counts: result.counts,
    ...(result.search
      ? {
          truncated: result.search.truncated,
          scanned_items: result.search.scannedItems,
          scan_limit: result.search.scanLimit,
        }
      : {}),
  };
}

function serializeItem(item: ContainerBrowseItem, runtime: McpRuntime) {
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
      agent: item.agentId ? { id: item.agentId, name: agent?.name ?? item.agentId } : null,
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
