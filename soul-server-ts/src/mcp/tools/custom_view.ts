import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BoardYjsContainerRef } from "../../db/session_db_types.js";
import type { CustomViewService } from "../../custom_view/custom_view_service.js";
import { SOULSTREAM_AGENT_SESSION_HEADER } from "../request_context.js";
import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";

import { resolveEffectiveCallerSessionId } from "./caller_session.js";
import {
  callerSessionIdSchema,
  errorMessage,
  expectedVersionSchema,
  idempotencyKeySchema,
  mutationToolDescription,
} from "./runbook_shared.js";

const containerSchema = z.object({
  kind: z.enum(["folder", "runbook"]),
  id: z.string().min(1),
});

export function registerCustomViewTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  server.registerTool(
    "create_custom_view",
    {
      description: mutationToolDescription(
        "현재 MCP caller session을 actor_kind='agent'로 하여 sandboxed HTML custom view board item을 생성한다.",
      ),
      inputSchema: {
        container: containerSchema,
        title: z.string().default("Custom view"),
        html: z.string(),
        x: z.number().optional(),
        y: z.number().optional(),
        idempotency_key: idempotencyKeySchema,
        caller_session_id: callerSessionIdSchema,
      },
    },
    async (input) =>
      mutation(runtime, input.caller_session_id, (service, actorSessionId) =>
        service.createCustomView({
          actorSessionId,
          container: toBoardYjsContainer(input.container),
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
    {
      description: mutationToolDescription(
        "커스텀 뷰 HTML을 전체 replace로 갱신한다. expected_revision이 맞지 않으면 충돌로 실패한다.",
      ),
      inputSchema: {
        custom_view_id: z.string().min(1),
        expected_revision: expectedVersionSchema,
        html: z.string(),
        title: z.string().nullable().optional(),
        idempotency_key: idempotencyKeySchema,
        caller_session_id: callerSessionIdSchema,
      },
    },
    async (input) =>
      mutation(runtime, input.caller_session_id, (service, actorSessionId) =>
        service.patchCustomView({
          actorSessionId,
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
    {
      description: "커스텀 뷰 HTML과 revision을 조회한다.",
      inputSchema: { custom_view_id: z.string().min(1) },
    },
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
    {
      description: "지정한 board container의 커스텀 뷰 목록을 조회한다.",
      inputSchema: {
        container: containerSchema,
        include_archived: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(100),
      },
    },
    async ({ container, include_archived, limit }) => {
      try {
        return jsonResult(
          await getCustomViewService(runtime).listCustomViews({
            container: toBoardYjsContainer(container),
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

function toBoardYjsContainer(input: z.infer<typeof containerSchema>): BoardYjsContainerRef {
  return { containerKind: input.kind, containerId: input.id };
}

async function mutation(
  runtime: McpRuntime,
  explicitCallerSessionId: string | null | undefined,
  fn: (service: CustomViewService, actorSessionId: string) => Promise<unknown>,
) {
  try {
    return jsonResult(await fn(
      getCustomViewService(runtime),
      requireCallerSessionId(explicitCallerSessionId),
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

function requireCallerSessionId(
  explicitCallerSessionId: string | null | undefined,
): string {
  const callerSessionId = resolveEffectiveCallerSessionId(explicitCallerSessionId);
  if (!callerSessionId) {
    throw new Error(
      `caller session id is required for custom view mutation tools. Send ${SOULSTREAM_AGENT_SESSION_HEADER}.`,
    );
  }
  return callerSessionId;
}
