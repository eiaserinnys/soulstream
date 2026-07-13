import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { BlockOperationDto, PageLinkKind } from "@soulstream/page-model";

import { verifyServiceBearerAuthorization } from "../auth/service_bearer.js";
import {
  PageMutationValidationError,
  PageMutationVersionConflictError,
  type PageBatchOperation,
  type PageMutationActor,
  type PageMutationCommand,
} from "./page_mutation_core.js";
import type { PageYjsService } from "./page_service.js";

export interface PageYjsHostOperationOptions {
  service: PageYjsService;
  authBearerToken: string;
}

const id = z.string().trim().min(1);
const jsonObject = z.record(z.string(), z.unknown());
const actorFields = {
  actor_kind: z.enum(["agent", "user", "system"]),
  actor_session_id: id.nullable().optional(),
  actor_user_id: id.nullable().optional(),
};
const mutationActorFields = {
  ...actorFields,
  idempotency_key: id,
  reason: z.string().nullable().optional(),
};
const mutationFields = {
  page_id: id,
  expected_version: z.number().int().positive(),
  ...mutationActorFields,
};
const placementFields = {
  parent_id: id.nullable(),
  parent_temp_id: id.nullable().optional(),
  after_block_id: id.nullable(),
  after_temp_id: id.nullable().optional(),
};
const contentFields = {
  block_type: id,
  text: z.string(),
  properties: jsonObject,
  collapsed: z.boolean().optional(),
};

const actorSchema = z.object(actorFields).superRefine((value, context) => {
  if (value.actor_kind === "agent" && !value.actor_session_id) {
    context.addIssue({ code: "custom", message: "agent actor_session_id is required" });
  }
  if (value.actor_kind === "user" && !value.actor_user_id) {
    context.addIssue({ code: "custom", message: "user actor_user_id is required" });
  }
});

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const pageInputSchema = z.object({
  id,
  title: id,
  daily_date: dateSchema.nullable(),
  metadata: jsonObject.optional(),
});

const blockInputSchema = z.object({
  id,
  parent_id: id.nullable(),
  position_key: id,
  type: id,
  text: z.string(),
  properties: jsonObject,
  collapsed: z.boolean(),
});

const batchOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("rename_page"), title: id }),
  z.object({ op: z.literal("set_page_archived"), archived: z.boolean() }),
  z.object({ op: z.literal("create_block"), temp_id: id, ...placementFields, ...contentFields }),
  z.object({ op: z.literal("update_block_text"), block_id: id, text: z.string() }),
  z.object({
    op: z.literal("update_block_type_and_properties"),
    block_id: id,
    block_type: id,
    properties: jsonObject,
  }),
  z.object({ op: z.literal("move_block"), block_id: id, ...placementFields }),
  z.object({ op: z.literal("delete_block_subtree"), block_id: id }),
  z.object({ op: z.literal("set_check_state"), block_id: id, checked: z.boolean() }),
]);

const schemas = {
  "get-page": z.object({ page_id: id, include_blocks: z.boolean().default(true) }),
  "find-page": z.object({ title: id }),
  "get-backlinks": z.object({
    page_id: id,
    kinds: z.array(z.enum(["mount", "inline_page", "block_ref"]))
      .min(1).default(["mount", "inline_page", "block_ref"]),
    cursor: id.optional(),
    include_self: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  "get-daily-page": z.object({ date: dateSchema.optional(), ...actorFields }),
  "create-page": z.object({
    page: pageInputSchema,
    blocks: z.array(blockInputSchema).optional(),
    operations: z.array(batchOperationSchema).min(1).optional(),
    ...mutationActorFields,
  }).superRefine((value, context) => {
    if (value.blocks && value.operations) {
      context.addIssue({ code: "custom", message: "blocks and operations are mutually exclusive" });
    }
  }),
  "rename-page": z.object({ ...mutationFields, title: id }),
  "archive-page": z.object(mutationFields),
  "unarchive-page": z.object(mutationFields),
  "create-block": z.object({ ...mutationFields, block_id: id.optional(), ...placementFields, ...contentFields }),
  "update-block-text": z.object({ ...mutationFields, block_id: id, text: z.string() }),
  "update-block-type-and-properties": z.object({
    ...mutationFields,
    block_id: id,
    block_type: id,
    properties: jsonObject,
  }),
  "move-block": z.object({ ...mutationFields, block_id: id, ...placementFields }),
  "delete-block-subtree": z.object({ ...mutationFields, block_id: id }),
  "set-check-state": z.object({ ...mutationFields, block_id: id, checked: z.boolean() }),
  "replace-page-markdown": z.object({ ...mutationFields, blocks: z.array(blockInputSchema) }),
  "batch-page-operations": z.union([
    z.object({
      page: pageInputSchema,
      operations: z.array(batchOperationSchema).min(1),
      ...mutationActorFields,
    }),
    z.object({
      ...mutationFields,
      operations: z.array(batchOperationSchema).min(1),
    }),
  ]),
} as const;

const ACTOR_OPERATIONS = new Set([
  "get-daily-page", "create-page", "rename-page", "archive-page", "unarchive-page",
  "create-block", "update-block-text", "update-block-type-and-properties", "move-block",
  "delete-block-subtree", "set-check-state", "replace-page-markdown", "batch-page-operations",
]);

export function registerPageYjsHostOperationRoutes(
  app: FastifyInstance,
  options: PageYjsHostOperationOptions,
): void {
  app.post<{ Params: { operation: string } }>(
    "/api/page-yjs/host/:operation",
    async (request, reply) => await handlePageYjsHostOperation(
      request,
      reply,
      request.params.operation,
      options,
    ),
  );
}

export async function handlePageYjsHostOperation(
  request: FastifyRequest,
  reply: FastifyReply,
  operation: string,
  options: PageYjsHostOperationOptions,
): Promise<FastifyReply> {
  const schema = schemas[operation as keyof typeof schemas];
  if (!schema) return errorReply(reply, 404, "PAGE_YJS_HOST_OPERATION_NOT_FOUND", `Unknown Page Yjs host operation: ${operation}`);

  const authorization = verifyServiceBearerAuthorization(
    request.headers.authorization,
    options.authBearerToken,
  );
  if (!authorization.ok) {
    return errorReply(reply, 401, "UNAUTHORIZED", `Page Yjs host bearer token is ${authorization.reason}`);
  }
  const parsed = schema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return errorReply(reply, 422, "INVALID_PAGE_YJS_HOST_REQUEST", parsed.error.message);
  }
  if (ACTOR_OPERATIONS.has(operation)) {
    const actorResult = actorSchema.safeParse(parsed.data);
    if (!actorResult.success) {
      return errorReply(reply, 422, "INVALID_PAGE_YJS_HOST_REQUEST", actorResult.error.message);
    }
  }

  try {
    return reply.send(await dispatch(operation, parsed.data, options.service));
  } catch (error) {
    if (error instanceof PageMutationVersionConflictError) {
      return errorReply(reply, 409, error.code, error.message);
    }
    if (error instanceof PageMutationValidationError) {
      return errorReply(reply, 422, error.code, error.message);
    }
    request.log.error({ err: error, operation }, "Page Yjs host operation failed");
    return errorReply(
      reply,
      500,
      "PAGE_YJS_HOST_OPERATION_FAILED",
      error instanceof Error ? error.message : "Page Yjs host operation failed",
    );
  }
}

async function dispatch(
  operation: string,
  raw: unknown,
  service: PageYjsService,
): Promise<unknown> {
  const input = raw as Record<string, unknown>;
  if (operation === "get-page") {
    const result = await service.getPage(input.page_id as string);
    return input.include_blocks === false ? { page: result.page } : result;
  }
  if (operation === "find-page") {
    return { page: await service.findPage(input.title as string) };
  }
  if (operation === "get-backlinks") {
    return await service.getBacklinks({
      pageId: input.page_id as string,
      kinds: input.kinds as PageLinkKind[],
      cursor: input.cursor as string | undefined,
      includeSelf: input.include_self as boolean,
      limit: input.limit as number,
    });
  }
  if (operation === "get-daily-page") {
    const result = await service.getDailyPage({
      date: input.date as string | undefined,
      actor: toActor(input),
    });
    return result.operation
      ? { ...result, operation: toOperationDto(result.operation) }
      : result;
  }
  const actor = toActor(input);
  const common = {
    actor,
    idempotencyKey: input.idempotency_key as string,
    reason: (input.reason as string | null | undefined) ?? null,
  };
  if (operation === "create-page") {
    const page = pageFromInput(input.page);
    return mutationResultDto(await service.createPage({
      page,
      ...initialCommand(input),
      ...common,
    }));
  }
  if (operation === "batch-page-operations" && input.page) {
    return mutationResultDto(await service.createPage({
      page: pageFromInput(input.page),
      initialCommand: {
        type: "batch_operations",
        operations: (input.operations as Record<string, unknown>[]).map(toBatchOperation),
      },
      ...common,
    }));
  }
  const command = commandFor(operation, input);
  return mutationResultDto(await service.mutatePage({
    pageId: input.page_id as string,
    expectedVersion: input.expected_version as number,
    command,
    ...common,
  }));
}

function mutationResultDto<T extends { operation: Parameters<typeof toOperationDto>[0]; idempotent?: boolean }>(
  result: T,
) {
  return {
    ...result,
    operation: toOperationDto(result.operation, result.idempotent === true),
  };
}

function toOperationDto(
  operation: {
    id: string;
    page_id: string;
    target_block_id: string | null;
    operation_type: string;
    actor_kind: "agent" | "user" | "system";
    actor_session_id: string | null;
    actor_user_id: string | null;
    expected_version: number;
    result_version: number;
  },
  idempotent = false,
): BlockOperationDto {
  return {
    id: operation.id,
    page_id: operation.page_id,
    target_block_id: operation.target_block_id,
    operation_type: operation.operation_type as BlockOperationDto["operation_type"],
    actor_kind: operation.actor_kind,
    actor_session_id: operation.actor_session_id,
    actor_user_id: operation.actor_user_id,
    expected_version: operation.expected_version,
    result_version: operation.result_version,
    ...(idempotent ? { idempotent: true } : {}),
  };
}

function pageFromInput(raw: unknown) {
  const page = raw as {
    id: string;
    title: string;
    daily_date: string | null;
    metadata?: Record<string, unknown>;
  };
  return {
    id: page.id,
    title: page.title,
    dailyDate: page.daily_date,
    metadata: page.metadata ?? {},
  };
}

function initialCommand(input: Record<string, unknown>) {
  if (input.blocks) {
    return {
      initialCommand: {
        type: "replace_page_markdown" as const,
        blocks: (input.blocks as Record<string, unknown>[]).map(toBlockInput),
      },
    };
  }
  if (input.operations) {
    return {
      initialCommand: {
        type: "batch_operations" as const,
        operations: (input.operations as Record<string, unknown>[]).map(toBatchOperation),
      },
    };
  }
  return {};
}

function commandFor(operation: string, input: Record<string, unknown>): PageMutationCommand {
  switch (operation) {
    case "rename-page":
      return { type: "rename_page", title: input.title as string };
    case "archive-page":
      return { type: "archive_page" };
    case "unarchive-page":
      return { type: "unarchive_page" };
    case "create-block":
      return {
        type: "create_block",
        id: input.block_id as string | undefined,
        ...placement(input),
        ...content(input),
      };
    case "update-block-text":
      return { type: "update_block_text", blockId: input.block_id as string, text: input.text as string };
    case "update-block-type-and-properties":
      return {
        type: "update_block_type_and_properties",
        blockId: input.block_id as string,
        blockType: input.block_type as string,
        properties: input.properties as Record<string, unknown>,
      };
    case "move-block":
      return { type: "move_block", blockId: input.block_id as string, ...placement(input) };
    case "delete-block-subtree":
      return { type: "delete_block_subtree", blockId: input.block_id as string };
    case "set-check-state":
      return { type: "set_check_state", blockId: input.block_id as string, checked: input.checked as boolean };
    case "replace-page-markdown":
      return { type: "replace_page_markdown", blocks: (input.blocks as Record<string, unknown>[]).map(toBlockInput) };
    case "batch-page-operations":
      return {
        type: "batch_operations",
        operations: (input.operations as Record<string, unknown>[]).map(toBatchOperation),
      };
    default:
      throw new PageMutationValidationError(`unsupported page operation: ${operation}`);
  }
}

function toBatchOperation(input: Record<string, unknown>): PageBatchOperation {
  switch (input.op) {
    case "rename_page":
      return { op: "rename_page", title: input.title as string };
    case "set_page_archived":
      return { op: "set_page_archived", archived: input.archived as boolean };
    case "create_block":
      return {
        op: "create_block",
        tempId: input.temp_id as string,
        ...placement(input),
        ...content(input),
      };
    case "update_block_text":
      return { op: "update_block_text", blockId: input.block_id as string, text: input.text as string };
    case "update_block_type_and_properties":
      return {
        op: "update_block_type_and_properties",
        blockId: input.block_id as string,
        blockType: input.block_type as string,
        properties: input.properties as Record<string, unknown>,
      };
    case "move_block":
      return { op: "move_block", blockId: input.block_id as string, ...placement(input) };
    case "delete_block_subtree":
      return { op: "delete_block_subtree", blockId: input.block_id as string };
    case "set_check_state":
      return { op: "set_check_state", blockId: input.block_id as string, checked: input.checked as boolean };
    default:
      throw new PageMutationValidationError(`unsupported batch operation: ${String(input.op)}`);
  }
}

function placement(input: Record<string, unknown>) {
  return {
    parentId: input.parent_id as string | null,
    parentTempId: input.parent_temp_id as string | null | undefined,
    afterBlockId: input.after_block_id as string | null,
    afterTempId: input.after_temp_id as string | null | undefined,
  };
}

function content(input: Record<string, unknown>) {
  return {
    blockType: input.block_type as string,
    text: input.text as string,
    properties: input.properties as Record<string, unknown>,
    collapsed: input.collapsed as boolean | undefined,
  };
}

function toBlockInput(input: Record<string, unknown>) {
  return {
    id: input.id as string,
    parentId: input.parent_id as string | null,
    positionKey: input.position_key as string,
    type: input.type as string,
    text: input.text as string,
    properties: input.properties as Record<string, unknown>,
    collapsed: input.collapsed as boolean,
  };
}

function toActor(input: Record<string, unknown>): PageMutationActor {
  return {
    actorKind: input.actor_kind as PageMutationActor["actorKind"],
    actorSessionId: (input.actor_session_id as string | null | undefined) ?? null,
    actorUserId: (input.actor_user_id as string | null | undefined) ?? null,
  };
}

function errorReply(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.status(status).send({ detail: { error: { code, message } } });
}
