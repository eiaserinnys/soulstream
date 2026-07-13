import { Buffer } from "node:buffer";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  PageMutationIdempotencyConflictError,
  PageMutationStateVectorConflictError,
  PageMutationValidationError,
  PageMutationVersionConflictError,
} from "./page_mutation_core.js";
import type { PageYjsService } from "./page_service.js";

const id = z.string().trim().min(1);
const sourceSchema = z.object({
  page_id: id,
  expected_version: z.number().int().positive(),
  expected_state_vector: id,
  block_ids: z.array(id).min(1),
});
const targetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("existing"),
    page_id: id,
    expected_version: z.number().int().positive(),
    expected_state_vector: id,
    parent_id: id.nullable(),
    after_block_id: id.nullable(),
  }),
  z.object({ kind: z.literal("new"), page_id: id, title: id }),
]);
const transferSchema = z.object({
  source: sourceSchema,
  target: targetSchema,
  source_mount: z.object({ title: id, temp_id: id }).optional(),
  idempotency_key: id,
  reason: z.string().nullable().optional(),
});

export function registerPageBlockTransferRoute(
  app: FastifyInstance,
  options: {
    service: Pick<PageYjsService, "transferBlocks">;
    resolveUser(request: FastifyRequest): Promise<{ email?: string; sub?: string } | null>;
  },
): void {
  app.post("/api/pages/block-transfers", async (request, reply) => {
    const user = await options.resolveUser(request);
    const userId = user?.email || user?.sub;
    if (typeof userId !== "string" || !userId.trim()) {
      return errorReply(reply, 401, "UNAUTHORIZED", "Dashboard user authentication required");
    }
    const parsed = transferSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error.message);
    let sourceVector: Uint8Array;
    let targetVector: Uint8Array | undefined;
    try {
      sourceVector = decodeBase64(parsed.data.source.expected_state_vector);
      targetVector = parsed.data.target.kind === "existing"
        ? decodeBase64(parsed.data.target.expected_state_vector)
        : undefined;
    } catch (error) {
      return invalid(reply, error instanceof Error ? error.message : "invalid state vector");
    }
    try {
      return reply.send(await options.service.transferBlocks({
        source: {
          pageId: parsed.data.source.page_id,
          expectedVersion: parsed.data.source.expected_version,
          expectedStateVector: sourceVector,
          blockIds: parsed.data.source.block_ids,
        },
        target: parsed.data.target.kind === "new"
          ? { kind: "new", pageId: parsed.data.target.page_id, title: parsed.data.target.title }
          : {
              kind: "existing",
              pageId: parsed.data.target.page_id,
              expectedVersion: parsed.data.target.expected_version,
              expectedStateVector: targetVector!,
              parentId: parsed.data.target.parent_id,
              afterBlockId: parsed.data.target.after_block_id,
            },
        sourceMount: parsed.data.source_mount
          ? { title: parsed.data.source_mount.title, tempId: parsed.data.source_mount.temp_id }
          : undefined,
        actor: { actorKind: "user", actorUserId: userId.trim() },
        idempotencyKey: `browser_page_transfer:${userId.trim()}:${parsed.data.source.page_id}:${parsed.data.idempotency_key}`,
        reason: parsed.data.reason ?? null,
      }));
    } catch (error) {
      if (
        error instanceof PageMutationVersionConflictError ||
        error instanceof PageMutationStateVectorConflictError ||
        error instanceof PageMutationIdempotencyConflictError
      ) return errorReply(reply, 409, error.code, error.message);
      if (error instanceof PageMutationValidationError) {
        return errorReply(reply, 422, error.code, error.message);
      }
      request.log.error({ err: error }, "Browser page block transfer failed");
      return errorReply(
        reply,
        500,
        "PAGE_BLOCK_TRANSFER_FAILED",
        error instanceof Error ? error.message : "Browser page block transfer failed",
      );
    }
  });
}

function decodeBase64(value: string): Uint8Array {
  const bytes = Buffer.from(value, "base64");
  const normalized = value.replace(/=+$/, "");
  if (!bytes.length || bytes.toString("base64").replace(/=+$/, "") !== normalized) {
    throw new Error("expected_state_vector must be canonical base64");
  }
  return new Uint8Array(bytes);
}

function invalid(reply: FastifyReply, message: string): FastifyReply {
  return errorReply(reply, 422, "INVALID_PAGE_BLOCK_TRANSFER_REQUEST", message);
}

function errorReply(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.status(status).send({ detail: { error: { code, message } } });
}
