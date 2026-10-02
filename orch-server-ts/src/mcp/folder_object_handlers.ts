import { errorResult, errorResultFromError, jsonResult, type CallToolResult, type folderObjectTools } from "@soulstream/mcp-contract";
import { executeFolderHostOperation, type FolderControlPlaneHostRouteOptions } from "../folders/folder_control_plane_host_route.js";
import { describeFolderOperationError } from "../folders/folder_workspace_routes.js";

import type { McpCallContext, McpHostOptions } from "./types.js";

type Args = Record<string, unknown>;
type Handler = (options: Pick<McpHostOptions, "folders">, args: Args, context: McpCallContext) => Promise<CallToolResult>;

export const folderObjectHandlers = {
  create_folder: (o, a, c) => mutate(o.folders, "create_folder", a, c, {
    parentFolderId: a.parent_folder_id, name: a.name, description: a.description,
    initialContext: a.initial_context, sortOrder: a.sort_order, idempotencyKey: a.idempotency_key,
  }),
  list_child_folders: (o, a) => query(o.folders, "list_child_folders", {
    folderId: a.folder_id ?? null, includeArchived: a.include_archived, limit: a.limit, cursor: a.cursor,
  }),
  get_folder: (o, a) => query(o.folders, "get_folder", { folderId: a.folder_id, view: a.view, cardId: a.card_id }),
  rename_folder: (o, a, c) => mutate(o.folders, "rename_folder", a, c, { ...mutationFields(a), name: a.name }),
  archive_folder: (o, a, c) => mutate(o.folders, "archive_folder", a, c, mutationFields(a)),
  unarchive_folder: (o, a, c) => mutate(o.folders, "unarchive_folder", a, c, mutationFields(a)),
  set_folder_status: (o, a, c) => mutate(o.folders, "set_folder_status", a, c, { ...mutationFields(a), status: a.status }),
  list_folder_operations: (o, a) => query(o.folders, "list_folder_operations", { folderId: a.folder_id, limit: a.limit, cursor: a.cursor }),
} satisfies Record<keyof typeof folderObjectTools, Handler>;

function mutationFields(args: Args) {
  return { folderId: args.folder_id, expectedVersion: args.expected_version,
    reason: args.reason, idempotencyKey: args.idempotency_key };
}

async function mutate(options: FolderControlPlaneHostRouteOptions, operation: string, args: Args, context: McpCallContext, body: Args) {
  try {
    const actor = mutationActor(args, context);
    return jsonResult(await request(options, operation, { ...actor, ...body, actorKind: actor.actorKind ?? "agent" }));
  } catch (error) { return errorResultFromError(error); }
}

async function query(options: FolderControlPlaneHostRouteOptions, operation: string, body: Args) {
  try { return jsonResult(await request(options, operation, body)); }
  catch (error) {
    if (operation === "get_folder" && (error as { statusCode?: number }).statusCode === 404) return jsonResult(null);
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

function mutationActor(args: Args, context: McpCallContext) {
  if (context.principal === "external") return { actorKind: "llm", actorSessionId: null };
  const explicit = typeof args.caller_session_id === "string" ? args.caller_session_id.trim() : "";
  const actorSessionId = explicit || context.callerSessionId?.trim();
  if (!actorSessionId) throw new Error("caller session id is required for folder mutation tools. Send x-soulstream-agent-session-id.");
  return { actorKind: "agent", actorSessionId };
}

async function request(options: FolderControlPlaneHostRouteOptions, operation: string, input: Args) {
  // Match FolderService's top-level snake conversion and the old HTTP JSON boundary.
  const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), value]));
  try {
    const result = await executeFolderHostOperation(options, operation, JSON.parse(JSON.stringify(body)));
    return JSON.parse(JSON.stringify(result ?? null)) as unknown;
  } catch (error) {
    const failure = describeFolderOperationError(error);
    // The legacy folder host envelope contains no conflict details or domain code on the worker error.
    throw Object.assign(new Error(`folder host ${operation} failed: ${failure.message}`), { statusCode: failure.status });
  }
}
