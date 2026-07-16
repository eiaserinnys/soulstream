import { Buffer } from "node:buffer";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type {
  BrowserBacklinkPageDto,
  BrowserBlockDto,
  BrowserBlockSearchDto,
  BrowserPageSearchDto,
  PageLinkKind,
} from "@soulstream/page-model";

import {
  PageMutationStateVectorConflictError,
  PageMutationValidationError,
  PageMutationVersionConflictError,
  type PageBatchOperation,
} from "./page_mutation_core.js";
import {
  PageBrowserBacklinkCursorError,
  PageListCursorError,
  type PageSessionDefaultsDto,
} from "./page_repository_reads.js";
import type { PageYjsService } from "./page_service.js";
import { registerPageBlockTransferRoute } from "./page_block_transfer_route.js";

export const pageBrowserRouteAuthRequirements = {
  "GET /api/pages": true,
  "GET /api/pages/search": true,
  "GET /api/pages/{pageId}": true,
  "GET /api/pages/{pageId}/session-defaults": true,
  "GET /api/pages/{pageId}/backlinks": true,
  "GET /api/blocks/search": true,
  "GET /api/blocks/{blockId}": true,
  "POST /api/pages/daily": true,
  "POST /api/pages/block-transfers": true,
  "POST /api/pages/{pageId}/operations": true,
  "PATCH /api/pages/{pageId}/starred": true,
} as const;

export interface PageBrowserUser {
  email?: string;
  sub?: string;
}

export function pageBrowserUserId(user: PageBrowserUser | null): string | null {
  const value = user?.email || user?.sub;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export interface PageBrowserRouteOptions {
  service: Pick<
    PageYjsService,
    | "listPages"
    | "getBrowserPage"
    | "getDailyPage"
    | "mutatePage"
    | "transferBlocks"
  >;
  reads: PageBrowserReads;
  resolveUser: (request: FastifyRequest) => Promise<PageBrowserUser | null>;
}

export interface PageBrowserReads {
  searchBrowserPages(input: { query: string; limit: number }): Promise<BrowserPageSearchDto>;
  searchBrowserBlocks(input: { query: string; limit: number }): Promise<BrowserBlockSearchDto>;
  getBrowserBlock(blockId: string): Promise<BrowserBlockDto | null>;
  getBrowserBacklinks(input: {
    pageId: string;
    kinds: readonly PageLinkKind[];
    cursor?: string;
    includeSelf?: boolean;
    limit: number;
  }): Promise<BrowserBacklinkPageDto>;
  resolvePageSessionDefaults(pageId: string): Promise<PageSessionDefaultsDto | null>;
}

const id = z.string().trim().min(1);
const jsonObject = z.record(z.string(), z.unknown());
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
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
const listQuerySchema = z.object({
  starred: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
  cursor: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const searchQuerySchema = z.object({
  q: z.string().transform((value) => value.trim()).pipe(z.string().min(1).max(200)),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const backlinksQuerySchema = z.object({
  kinds: z.string().optional(),
  cursor: id.optional(),
  include_self: z.enum(["true", "false"]).optional()
    .transform((value) => value === "true"),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const dailySchema = z.object({ date: date.optional() });
const mutationSchema = z.object({
  expected_version: z.number().int().positive(),
  expected_state_vector: id,
  idempotency_key: id,
  reason: z.string().nullable().optional(),
  operations: z.array(batchOperationSchema).min(1),
});
const starredSchema = z.object({
  starred: z.boolean(),
  expected_version: z.number().int().positive(),
  idempotency_key: id,
  reason: z.string().nullable().optional(),
});

export function registerPageBrowserRoutes(
  app: FastifyInstance,
  options: PageBrowserRouteOptions,
): void {
  registerPageBlockTransferRoute(app, options);
  app.get("/api/pages", async (request, reply) => {
    const userId = await resolveUserId(request, options);
    if (!userId) return unauthorized(reply);
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) return invalid(reply, parsed.error.message);
    try {
      return reply.send(await options.service.listPages({
        starred: parsed.data.starred,
        cursor: parsed.data.cursor,
        limit: parsed.data.limit,
      }));
    } catch (error) {
      return routeError(request, reply, error, "list");
    }
  });

  app.get("/api/pages/search", async (request, reply) => {
    const userId = await resolveUserId(request, options);
    if (!userId) return unauthorized(reply);
    const parsed = searchQuerySchema.safeParse(request.query);
    if (!parsed.success) return invalid(reply, parsed.error.message);
    try {
      return reply.send(await options.reads.searchBrowserPages({
        query: parsed.data.q,
        limit: parsed.data.limit,
      }));
    } catch (error) {
      return routeError(request, reply, error, "page-search");
    }
  });

  app.get("/api/blocks/search", async (request, reply) => {
    const userId = await resolveUserId(request, options);
    if (!userId) return unauthorized(reply);
    const parsed = searchQuerySchema.safeParse(request.query);
    if (!parsed.success) return invalid(reply, parsed.error.message);
    try {
      return reply.send(await options.reads.searchBrowserBlocks({
        query: parsed.data.q,
        limit: parsed.data.limit,
      }));
    } catch (error) {
      return routeError(request, reply, error, "block-search");
    }
  });

  app.get<{ Params: { blockId: string } }>(
    "/api/blocks/:blockId",
    async (request, reply) => {
      const userId = await resolveUserId(request, options);
      if (!userId) return unauthorized(reply);
      const parsed = id.safeParse(request.params.blockId);
      if (!parsed.success) return invalid(reply, parsed.error.message);
      try {
        const block = await options.reads.getBrowserBlock(parsed.data);
        return block
          ? reply.send(block)
          : errorReply(reply, 404, "BLOCK_NOT_FOUND", `block not found: ${parsed.data}`);
      } catch (error) {
        return routeError(request, reply, error, "block-read");
      }
    },
  );

  app.get<{ Params: { pageId: string } }>(
    "/api/pages/:pageId/session-defaults",
    async (request, reply) => {
      const userId = await resolveUserId(request, options);
      if (!userId) return unauthorized(reply);
      const pageId = id.safeParse(request.params.pageId);
      if (!pageId.success) return invalid(reply, pageId.error.message);
      try {
        return reply.send(await options.reads.resolvePageSessionDefaults(pageId.data));
      } catch (error) {
        return routeError(request, reply, error, "session-defaults");
      }
    },
  );

  app.get<{ Params: { pageId: string } }>(
    "/api/pages/:pageId",
    async (request, reply) => {
      const userId = await resolveUserId(request, options);
      if (!userId) return unauthorized(reply);
      try {
        return reply.send(await options.service.getBrowserPage(request.params.pageId));
      } catch (error) {
        return routeError(request, reply, error, "read");
      }
    },
  );

  app.get<{ Params: { pageId: string } }>(
    "/api/pages/:pageId/backlinks",
    async (request, reply) => {
      const userId = await resolveUserId(request, options);
      if (!userId) return unauthorized(reply);
      const pageId = id.safeParse(request.params.pageId);
      const query = backlinksQuerySchema.safeParse(request.query);
      if (!pageId.success) return invalid(reply, pageId.error.message);
      if (!query.success) return invalid(reply, query.error.message);
      let kinds: PageLinkKind[];
      try {
        kinds = parseLinkKinds(query.data.kinds);
      } catch (error) {
        return invalid(reply, error instanceof Error ? error.message : "invalid link kinds");
      }
      try {
        return reply.send(await options.reads.getBrowserBacklinks({
          pageId: pageId.data,
          kinds,
          cursor: query.data.cursor,
          includeSelf: query.data.include_self,
          limit: query.data.limit,
        }));
      } catch (error) {
        return routeError(request, reply, error, "backlinks");
      }
    },
  );

  app.post("/api/pages/daily", async (request, reply) => {
    const userId = await resolveUserId(request, options);
    if (!userId) return unauthorized(reply);
    const parsed = dailySchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error.message);
    try {
      return reply.send(await options.service.getDailyPage({
        date: parsed.data.date,
        actor: userActor(userId),
      }));
    } catch (error) {
      return routeError(request, reply, error, "daily");
    }
  });

  app.post<{ Params: { pageId: string } }>(
    "/api/pages/:pageId/operations",
    async (request, reply) => {
      const userId = await resolveUserId(request, options);
      if (!userId) return unauthorized(reply);
      const parsed = mutationSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, parsed.error.message);
      let expectedStateVector: Uint8Array;
      try {
        expectedStateVector = decodeBase64(parsed.data.expected_state_vector);
      } catch (error) {
        return invalid(reply, error instanceof Error ? error.message : "invalid state vector");
      }
      try {
        return reply.send(await options.service.mutatePage({
          pageId: request.params.pageId,
          expectedVersion: parsed.data.expected_version,
          expectedStateVector,
          command: {
            type: "batch_operations",
            operations: parsed.data.operations.map(toBatchOperation),
          },
          actor: userActor(userId),
          idempotencyKey: browserIdempotencyKey(
            userId,
            request.params.pageId,
            parsed.data.idempotency_key,
          ),
          reason: parsed.data.reason ?? null,
        }));
      } catch (error) {
        return routeError(request, reply, error, "batch");
      }
    },
  );

  app.patch<{ Params: { pageId: string } }>(
    "/api/pages/:pageId/starred",
    async (request, reply) => {
      const userId = await resolveUserId(request, options);
      if (!userId) return unauthorized(reply);
      const parsed = starredSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, parsed.error.message);
      try {
        return reply.send(await options.service.mutatePage({
          pageId: request.params.pageId,
          expectedVersion: parsed.data.expected_version,
          command: { type: "set_page_starred", starred: parsed.data.starred },
          actor: userActor(userId),
          idempotencyKey: browserIdempotencyKey(
            userId,
            request.params.pageId,
            parsed.data.idempotency_key,
          ),
          reason: parsed.data.reason ?? null,
        }));
      } catch (error) {
        return routeError(request, reply, error, "starred");
      }
    },
  );
}

async function resolveUserId(
  request: FastifyRequest,
  options: PageBrowserRouteOptions,
): Promise<string | null> {
  return pageBrowserUserId(await options.resolveUser(request));
}

function userActor(userId: string) {
  return { actorKind: "user" as const, actorUserId: userId };
}

function browserIdempotencyKey(userId: string, pageId: string, requestKey: string): string {
  return `browser_page:${userId}:${pageId}:${requestKey}`;
}

function toBatchOperation(input: z.infer<typeof batchOperationSchema>): PageBatchOperation {
  switch (input.op) {
    case "rename_page":
      return { op: input.op, title: input.title };
    case "set_page_archived":
      return { op: input.op, archived: input.archived };
    case "create_block":
      return {
        op: input.op,
        tempId: input.temp_id,
        ...placement(input),
        blockType: input.block_type,
        text: input.text,
        properties: input.properties,
        collapsed: input.collapsed,
      };
    case "update_block_text":
      return { op: input.op, blockId: input.block_id, text: input.text };
    case "update_block_type_and_properties":
      return {
        op: input.op,
        blockId: input.block_id,
        blockType: input.block_type,
        properties: input.properties,
      };
    case "move_block":
      return { op: input.op, blockId: input.block_id, ...placement(input) };
    case "delete_block_subtree":
      return { op: input.op, blockId: input.block_id };
    case "set_check_state":
      return { op: input.op, blockId: input.block_id, checked: input.checked };
  }
}

function placement(input: {
  parent_id: string | null;
  parent_temp_id?: string | null;
  after_block_id: string | null;
  after_temp_id?: string | null;
}) {
  return {
    parentId: input.parent_id,
    parentTempId: input.parent_temp_id,
    afterBlockId: input.after_block_id,
    afterTempId: input.after_temp_id,
  };
}

function decodeBase64(value: string): Uint8Array {
  const bytes = Buffer.from(value, "base64");
  const normalized = value.replace(/=+$/, "");
  if (!bytes.length || bytes.toString("base64").replace(/=+$/, "") !== normalized) {
    throw new Error("expected_state_vector must be canonical base64");
  }
  return new Uint8Array(bytes);
}

const LINK_KINDS: readonly PageLinkKind[] = ["mount", "inline_page", "block_ref"];

function parseLinkKinds(value: string | undefined): PageLinkKind[] {
  if (value === undefined) return [...LINK_KINDS];
  const raw = value.split(",").map((kind) => kind.trim());
  if (raw.length === 0 || raw.some((kind) => !kind)) {
    throw new Error("kinds must contain one or more link kinds");
  }
  const selected = new Set(raw);
  if ([...selected].some((kind) => !LINK_KINDS.includes(kind as PageLinkKind))) {
    throw new Error("kinds must contain only mount, inline_page, or block_ref");
  }
  return LINK_KINDS.filter((kind) => selected.has(kind));
}

function routeError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  operation: string,
): FastifyReply {
  if (
    error instanceof PageMutationVersionConflictError ||
    error instanceof PageMutationStateVectorConflictError
  ) return errorReply(reply, 409, error.code, error.message);
  if (
    error instanceof PageMutationValidationError ||
    error instanceof PageListCursorError ||
    error instanceof PageBrowserBacklinkCursorError
  ) {
    return errorReply(reply, 422, error.code, error.message);
  }
  if (error instanceof Error && error.message.includes("page not found")) {
    return errorReply(reply, 404, "PAGE_NOT_FOUND", error.message);
  }
  request.log.error({ err: error, operation }, "Browser page operation failed");
  return errorReply(
    reply,
    500,
    "PAGE_BROWSER_OPERATION_FAILED",
    error instanceof Error ? error.message : "Browser page operation failed",
  );
}

function unauthorized(reply: FastifyReply): FastifyReply {
  return errorReply(reply, 401, "UNAUTHORIZED", "Dashboard user authentication required");
}

function invalid(reply: FastifyReply, message: string): FastifyReply {
  return errorReply(reply, 422, "INVALID_PAGE_BROWSER_REQUEST", message);
}

function errorReply(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.status(status).send({ detail: { error: { code, message } } });
}
