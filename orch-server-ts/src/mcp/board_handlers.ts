import { boardTools, jsonResult, errorResult, type CallToolResult } from "@soulstream/mcp-contract";
import { CatalogService } from "./board_catalog_service.js";
import { CustomViewService } from "./board_custom_view_service.js";
import { createBoardLocalPorts } from "./board_local_ports.js";
import type { FolderBrowseItem } from "./board_folder_browse.js";
import { dispatchNodeRegistryEventsToSessionBroadcaster } from "../runtime/node_session_event_dispatcher.js";
import type { McpCallContext, McpHostOptions } from "./types.js";

type Args = Record<string, any>;
type Handler = (options: McpHostOptions, args: Args, context: McpCallContext) => Promise<CallToolResult>;
export const boardHandlers = {
  list_folders: async (o, a, c) => {
    const service = services(o, c);
    const call: (input: Args) => Promise<CallToolResult> = async () => {
      const folders = await service.catalog.listFolders();
      return jsonResult({ folders });
    };
    return call(a);
  },
  browse_folder: async (o, a, c) => {
    const service = services(o, c);
    const call: (input: Args) => Promise<CallToolResult> = async ({ folder_id, session_cursor, session_limit, cursor, limit, include_archived }) => {
      try {
        const result = await service.catalog.browseFolder({
          folderId: folder_id,
          sessionCursor: session_cursor ?? 0,
          sessionLimit: session_limit ?? 20,
          cursor,
          limit,
          includeArchived: include_archived,
        });
        return jsonResult({
          folder_id,
          folder: result.folder,
          child_folders: result.childFolders,
          sessions: result.sessions,
          sessions_page: result.sessionsPage,
          board_items: result.boardItems,
          items: await serializeItems(result.items, o, c),
          items_page: result.itemsPage,
          counts: result.counts,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    };
    return call(a);
  },
  move_folder: async (o, a, c) => {
    const service = services(o, c);
    const call: (input: Args) => Promise<CallToolResult> = async ({ folder_id, parent_folder_id }) => {
      try {
        await service.catalog.setFolderParent(
          folder_id,
          parent_folder_id ?? null,
        );
        return jsonResult({ ok: true });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    };
    return call(a);
  },
  delete_folder: async (o, a, c) => {
    const service = services(o, c);
    const call: (input: Args) => Promise<CallToolResult> = async ({ folder_id }) => {
      try {
        await service.catalog.deleteFolder(folder_id);
        return jsonResult({ ok: true });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    };
    return call(a);
  },
  move_sessions_to_folder: async (o, a, c) => {
    const service = services(o, c);
    const call: (input: Args) => Promise<CallToolResult> = async ({ session_ids, folder_id }) => {
      try {
        await service.catalog.moveSessionsToFolder(
          session_ids,
          folder_id ?? null,
        );
        return jsonResult({ ok: true, moved: session_ids.length });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    };
    return call(a);
  },
  update_board_item_position: async (o, a, c) => {
    const service = services(o, c);
    const call: (input: Args) => Promise<CallToolResult> = async ({ board_item_id, x, y }) => {
      try {
        await service.catalog.updateBoardItemPosition(board_item_id, x, y);
        return jsonResult({ ok: true, board_item_id });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    };
    return call(a);
  },
  move_board_item_to_folder: async (o, a, c) => {
    const service = services(o, c);
    const call: (input: Args) => Promise<CallToolResult> = async ({ board_item_id, folder_id, x, y, idempotency_key }) => {
      try {
        if ((x === undefined) !== (y === undefined)) {
          return errorResult("x and y must be supplied together");
        }
        const result = await service.catalog.moveBoardItemToFolder({
          boardItemId: board_item_id,
          folderId: folder_id,
          ...(x !== undefined && y !== undefined ? { position: { x, y } } : {}),
          idempotencyKey: idempotency_key,
        });
        return jsonResult({
          ok: true,
          board_item: result.boardItem,
          ...(result.enrolled ? { enrolled: true } : {}),
          idempotency_key,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    };
    return call(a);
  },
  create_markdown_document: async (o, a, c) => {
    const service = services(o, c);
    const call: (input: Args) => Promise<CallToolResult> = async ({ folder_id, title, body, x, y }) => {
      try {
        const result = await service.catalog.createMarkdownDocument({
          folderId: folder_id,
          title,
          body: body ?? "",
          x,
          y,
        });
        return jsonResult(result);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    };
    return call(a);
  },
  get_markdown_document: async (o, a, c) => {
    const service = services(o, c);
    const call: (input: Args) => Promise<CallToolResult> = async ({ document_id }) => {
      try {
        const document = await service.catalog.getMarkdownDocument(document_id);
        if (!document) return errorResult("document not found");
        return jsonResult(document);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    };
    return call(a);
  },
  update_markdown_document: async (o, a, c) => {
    const service = services(o, c);
    const call: (input: Args) => Promise<CallToolResult> = async ({ document_id, expected_version, title, body }) => {
      try {
        if (title === undefined && body === undefined) {
          return errorResult("No fields to update");
        }
        const document = await service.catalog.updateMarkdownDocument(
          document_id,
          {
            expectedVersion: expected_version,
            ...(title !== undefined ? { title } : {}),
            ...(body !== undefined ? { body } : {}),
          },
        );
        if (!document) return errorResult("document not found");
        return jsonResult(document);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    };
    return call(a);
  },
  delete_markdown_document: async (o, a, c) => {
    const service = services(o, c);
    const call: (input: Args) => Promise<CallToolResult> = async ({ document_id }) => {
      try {
        await service.catalog.deleteMarkdownDocument(document_id);
        return jsonResult({ ok: true, document_id });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    };
    return call(a);
  },
  get_folder_system_prompt: async (o, a, c) => {
    const service = services(o, c);
    const call: (input: Args) => Promise<CallToolResult> = async ({ folder_id }) => {
      try {
        const prompt =
          await service.catalog.getFolderSystemPrompt(folder_id);
        return jsonResult({ folder_id, system_prompt: prompt });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    };
    return call(a);
  },
  set_folder_system_prompt: async (o, a, c) => {
    const service = services(o, c);
    const call: (input: Args) => Promise<CallToolResult> = async ({ folder_id, system_prompt }) => {
      try {
        await service.catalog.setFolderSystemPrompt(
          folder_id,
          system_prompt ?? null,
        );
        return jsonResult({ ok: true });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    };
    return call(a);
  },
  search_folder_items: async (o, a, c) => run(async () => {
    const result = await services(o, c).catalog.searchFolderItems({ folderId: a.folder_id, query: a.query, limit: a.limit, includeArchived: a.include_archived });
    return { folder_id: result.folderId, items: await serializeItems(result.items, o, c),
      page: { cursor: result.page.cursor, limit: result.page.limit, total: result.page.total, next_cursor: result.page.nextCursor },
      counts: result.counts, ...(result.search ? { truncated: result.search.truncated, scanned_items: result.search.scannedItems, scan_limit: result.search.scanLimit } : {}) };
  }),
  create_custom_view: async (o, a, c) => run(() => services(o, c).views.createCustomView({
    ...actor(a, c), folderId: a.folder_id, title: a.title, html: a.html, x: a.x, y: a.y, idempotencyKey: a.idempotency_key,
  })),
  patch_custom_view: async (o, a, c) => run(() => services(o, c).views.patchCustomView({
    ...actor(a, c), customViewId: a.custom_view_id, expectedRevision: a.expected_revision, html: a.html,
    ...(Object.hasOwn(a, "title") ? { title: a.title ?? null } : {}), idempotencyKey: a.idempotency_key,
  })),
  get_custom_view: async (o, a, c) => run(() => services(o, c).views.getCustomView(a.custom_view_id)),
  list_custom_views: async (o, a, c) => run(() => services(o, c).views.listCustomViews({ folderId: a.folder_id, includeArchived: a.include_archived, limit: a.limit })),
} satisfies Record<keyof typeof boardTools, Handler>;

function actor(args: Args, context: McpCallContext) {
  if (context.principal === "external") return { actorKind: "llm" as const, actorSessionId: null };
  const explicit = typeof args.caller_session_id === "string" ? args.caller_session_id.trim() : "";
  const actorSessionId = explicit || context.callerSessionId?.trim();
  if (!actorSessionId) throw new Error("caller session id is required for custom view mutation tools. Send x-soulstream-agent-session-id.");
  return { actorKind: "agent" as const, actorSessionId };
}
function services(options: McpHostOptions, context: McpCallContext) {
  const local = createBoardLocalPorts(options);
  const emit = (data: Record<string, unknown>) => {
    dispatchNodeRegistryEventsToSessionBroadcaster([{
      type: "node_session_event", nodeId: context.nodeId, data,
    }], options.board.broadcaster);
  };
  const broadcaster = {
    emitCatalogUpdated: async (folders: unknown, sessions_delta: unknown, board_items_delta: unknown) => {
      emit({ type: "catalog_updated", folders, sessions_delta, board_items_delta });
    },
    emitCustomViewUpdated: async (agentSessionId: string, customViewId: string, boardItemId: string, revision: number) => {
      emit({ type: "event", agentSessionId, event: { type: "custom_view_updated", customViewId, boardItemId, revision } });
    },
  };
  return { catalog: new CatalogService(local.store, broadcaster, local.mutations, local.folders),
    views: new CustomViewService(local.store, local.mutations, broadcaster) };
}
async function run(fn: () => Promise<unknown>) {
  try { return jsonResult(await fn()); } catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
}
async function serializeItems(items: FolderBrowseItem[], options: McpHostOptions, context: McpCallContext) {
  return Promise.all(items.map(async item => {
    const base = { type: item.type, board_item_id: item.boardItemId, archived: item.archived, updated_at: item.updatedAt };
    if (item.type === "session") {
      const profiles = item.agentId && item.nodeId ? await options.board.listAgentProfiles(item.nodeId) : undefined;
      const agent = item.agentId ? profiles?.[item.agentId] : undefined;
      return { ...base, agent_session_id: item.agentSessionId, display_name: item.displayName, status: item.status,
        agent: item.agentId ? { id: item.agentId, name: typeof agent?.name === "string" ? agent.name : item.agentId } : null,
        session_type: item.sessionType, created_at: item.createdAt, event_count: item.eventCount,
        away_summary: item.awaySummary, caller_session_id: item.callerSessionId, predecessor_session_id: item.predecessorSessionId,
        node_id: item.nodeId, last_event_id: item.lastEventId, last_read_event_id: item.lastReadEventId };
    }
    if (item.type === "markdown") return { ...base, id: item.id, title: item.title, preview: item.preview };
    return { ...base, id: item.id, title: item.title };
  }));
}
