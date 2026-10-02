import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { boardTools } from "@soulstream/mcp-contract";
import { registerOrchestratorTools } from "../orchestrator_tools.js";

import type { CustomViewService } from "../../custom_view/custom_view_service.js";
import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";

import {
  requireMcpMutationActor,
  type McpMutationActor,
} from "./caller_session.js";
import { errorMessage } from "./folder_tool_shared.js";

export function registerCustomViewTools(server: McpServer, runtime: McpRuntime): void {
  registerOrchestratorTools(server, runtime, [boardTools.create_custom_view, boardTools.patch_custom_view, boardTools.get_custom_view, boardTools.list_custom_views]);
}

export function registerCustomViewToolsLegacy(
  server: McpServer,
  runtime: McpRuntime,
): void {
  server.registerTool(
    "create_custom_view",
    boardTools.create_custom_view.config,
    async (input) =>
      mutation(runtime, input.caller_session_id, (service, actor) =>
        service.createCustomView({
          ...actor,
          folderId: input.folder_id,
          title: input.title,
          html: input.html,
          x: input.x,
          y: input.y,
          idempotencyKey: input.idempotency_key,
        }),
      ),
  );

  server.registerTool(
    "patch_custom_view",
    boardTools.patch_custom_view.config,
    async (input) =>
      mutation(runtime, input.caller_session_id, (service, actor) =>
        service.patchCustomView({
          ...actor,
          customViewId: input.custom_view_id,
          expectedRevision: input.expected_revision,
          html: input.html,
          ...(Object.prototype.hasOwnProperty.call(input, "title")
            ? { title: input.title ?? null }
            : {}),
          idempotencyKey: input.idempotency_key,
        }),
      ),
  );

  server.registerTool(
    "get_custom_view",
    boardTools.get_custom_view.config,
    async ({ custom_view_id }) => {
      try {
        return jsonResult(await getCustomViewService(runtime).getCustomView(custom_view_id));
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "list_custom_views",
    boardTools.list_custom_views.config,
    async ({ folder_id, include_archived, limit }) => {
      try {
        return jsonResult(
          await getCustomViewService(runtime).listCustomViews({
            folderId: folder_id,
            includeArchived: include_archived,
            limit,
          }),
        );
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );
}

async function mutation(
  runtime: McpRuntime,
  explicitCallerSessionId: string | null | undefined,
  fn: (service: CustomViewService, actor: McpMutationActor) => Promise<unknown>,
) {
  try {
    return jsonResult(await fn(
      getCustomViewService(runtime),
      requireMcpMutationActor(
        explicitCallerSessionId,
        "custom view mutation tools",
      ),
    ));
  } catch (err) {
    return errorResult(errorMessage(err));
  }
}

function getCustomViewService(runtime: McpRuntime): CustomViewService {
  if (!runtime.customViewService) {
    throw new Error("custom view service is not configured");
  }
  return runtime.customViewService;
}
