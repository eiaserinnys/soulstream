import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  authenticateDashboardHttpRequest,
  type BoardYjsAuthConfig,
} from "../collaboration/board_yjs_auth.js";
import type {
  RunbookItemRow,
  RunbookRow,
  RunbookSectionRow,
  RunbookSnapshot,
} from "../db/session_db_types.js";

import { RunbookVersionConflict } from "./runbook_models.js";
import type { RunbookService } from "./runbook_service.js";

interface RunbookCrudHttpConfig {
  service: RunbookService;
  auth: BoardYjsAuthConfig;
}

interface RunbookParams {
  runbookId: string;
}

interface SectionParams extends RunbookParams {
  sectionId: string;
}

interface ItemParams extends RunbookParams {
  itemId: string;
}

interface CreateItemParams extends SectionParams {}

type Body = Record<string, unknown>;

type UserActor = {
  actorKind: "user";
  actorSessionId: string;
  actorUserId: string;
};

export function registerRunbookCrudHttpRoutes(
  fastify: FastifyInstance,
  config: RunbookCrudHttpConfig,
): void {
  fastify.post<{ Params: RunbookParams; Body: Body }>(
    "/api/runbooks/:runbookId/sections",
    async (request, reply) => {
      const parsed = parseCreateSection(request.body);
      if (!parsed.ok) return invalid(reply, parsed.error);
      return runMutation(request, reply, config, { kind: "runbook" }, async (actor) =>
        await config.service.createSection({
          ...actor,
          runbookId: request.params.runbookId,
          sectionId: parsed.value.sectionId,
          title: parsed.value.title,
          afterSectionId: parsed.value.afterSectionId,
          beforeSectionId: parsed.value.beforeSectionId,
          idempotencyKey: parsed.value.idempotencyKey,
        }));
    },
  );

  fastify.post<{ Params: SectionParams; Body: Body }>(
    "/api/runbooks/:runbookId/sections/:sectionId",
    async (request, reply) => {
      const parsed = parseUpdateSection(request.body);
      if (!parsed.ok) return invalid(reply, parsed.error);
      return runMutation(request, reply, config, {
        kind: "section",
        targetId: request.params.sectionId,
      }, async (actor) => await config.service.patchSection({
        ...actor,
        runbookId: request.params.runbookId,
        sectionId: request.params.sectionId,
        expectedVersion: parsed.value.expectedVersion,
        title: parsed.value.title,
        reason: parsed.value.reason,
        idempotencyKey: parsed.value.idempotencyKey,
      }));
    },
  );

  fastify.post<{ Params: SectionParams; Body: Body }>(
    "/api/runbooks/:runbookId/sections/:sectionId/move",
    async (request, reply) => {
      const parsed = parseMove(request.body, "section");
      if (!parsed.ok) return invalid(reply, parsed.error);
      return runMutation(request, reply, config, {
        kind: "section",
        targetId: request.params.sectionId,
      }, async (actor) => await config.service.moveSection({
        ...actor,
        runbookId: request.params.runbookId,
        sectionId: request.params.sectionId,
        expectedVersion: parsed.value.expectedVersion,
        afterSectionId: parsed.value.afterId,
        beforeSectionId: parsed.value.beforeId,
        reason: parsed.value.reason,
        idempotencyKey: parsed.value.idempotencyKey,
      }));
    },
  );

  fastify.post<{ Params: SectionParams; Body: Body }>(
    "/api/runbooks/:runbookId/sections/:sectionId/archive",
    async (request, reply) => {
      const parsed = parseVersioned(request.body);
      if (!parsed.ok) return invalid(reply, parsed.error);
      return runMutation(request, reply, config, {
        kind: "section",
        targetId: request.params.sectionId,
      }, async (actor) => await config.service.patchSection({
        ...actor,
        runbookId: request.params.runbookId,
        sectionId: request.params.sectionId,
        expectedVersion: parsed.value.expectedVersion,
        archived: true,
        reason: parsed.value.reason,
        idempotencyKey: parsed.value.idempotencyKey,
      }));
    },
  );

  fastify.post<{ Params: CreateItemParams; Body: Body }>(
    "/api/runbooks/:runbookId/sections/:sectionId/items",
    async (request, reply) => {
      const parsed = parseCreateItem(request.body);
      if (!parsed.ok) return invalid(reply, parsed.error);
      return runMutation(request, reply, config, {
        kind: "section",
        targetId: request.params.sectionId,
      }, async (actor) => await config.service.createItem({
        ...actor,
        runbookId: request.params.runbookId,
        sectionId: request.params.sectionId,
        itemId: parsed.value.itemId,
        title: parsed.value.title,
        howTo: parsed.value.howTo,
        afterItemId: parsed.value.afterItemId,
        beforeItemId: parsed.value.beforeItemId,
        idempotencyKey: parsed.value.idempotencyKey,
      }));
    },
  );

  fastify.post<{ Params: ItemParams; Body: Body }>(
    "/api/runbooks/:runbookId/items/:itemId",
    async (request, reply) => {
      const parsed = parseUpdateItem(request.body);
      if (!parsed.ok) return invalid(reply, parsed.error);
      return runMutation(request, reply, config, {
        kind: "item",
        targetId: request.params.itemId,
      }, async (actor) => await config.service.patchItem({
        ...actor,
        runbookId: request.params.runbookId,
        itemId: request.params.itemId,
        expectedVersion: parsed.value.expectedVersion,
        ...(parsed.value.title === undefined ? {} : { title: parsed.value.title }),
        ...(parsed.value.howTo === undefined ? {} : { howTo: parsed.value.howTo }),
        reason: parsed.value.reason,
        idempotencyKey: parsed.value.idempotencyKey,
      }));
    },
  );

  fastify.post<{ Params: ItemParams; Body: Body }>(
    "/api/runbooks/:runbookId/items/:itemId/move",
    async (request, reply) => {
      const parsed = parseMove(request.body, "item");
      if (!parsed.ok) return invalid(reply, parsed.error);
      return runMutation(request, reply, config, {
        kind: "item",
        targetId: request.params.itemId,
      }, async (actor) => await config.service.moveItem({
        ...actor,
        runbookId: request.params.runbookId,
        itemId: request.params.itemId,
        expectedVersion: parsed.value.expectedVersion,
        sectionId: optionalString(request.body?.sectionId ?? request.body?.section_id),
        afterItemId: parsed.value.afterId,
        beforeItemId: parsed.value.beforeId,
        reason: parsed.value.reason,
        idempotencyKey: parsed.value.idempotencyKey,
      }));
    },
  );

  fastify.post<{ Params: ItemParams; Body: Body }>(
    "/api/runbooks/:runbookId/items/:itemId/archive",
    async (request, reply) => {
      const parsed = parseVersioned(request.body);
      if (!parsed.ok) return invalid(reply, parsed.error);
      return runMutation(request, reply, config, {
        kind: "item",
        targetId: request.params.itemId,
      }, async (actor) => await config.service.patchItem({
        ...actor,
        runbookId: request.params.runbookId,
        itemId: request.params.itemId,
        expectedVersion: parsed.value.expectedVersion,
        archived: true,
        reason: parsed.value.reason,
        idempotencyKey: parsed.value.idempotencyKey,
      }));
    },
  );
}

async function runMutation(
  request: FastifyRequest<{ Params: RunbookParams }>,
  reply: FastifyReply,
  config: RunbookCrudHttpConfig,
  target: { kind: "runbook" | "section" | "item"; targetId?: string },
  mutate: (actor: UserActor) => Promise<{
    snapshot: RunbookSnapshot;
    operation: unknown;
    eventId: number;
    idempotent?: boolean;
  }>,
): Promise<unknown> {
  let userId: string;
  try {
    userId = (await authenticateDashboardHttpRequest({
      requestHeaders: request.headers,
      config: config.auth,
    })).subject;
  } catch (error) {
    return reply.code(401).send(errorPayload(
      "UNAUTHORIZED",
      error instanceof Error ? error.message : "Authentication failed",
    ));
  }

  const snapshot = await config.service.getRunbook(request.params.runbookId);
  if (!snapshot) return reply.code(404).send(errorPayload("RUNBOOK_NOT_FOUND", "Runbook not found"));
  const context = resolveTarget(snapshot, target);
  if (!context.found) {
    const label = target.kind === "item" ? "item" : "section";
    return reply.code(404).send(errorPayload(`RUNBOOK_${label.toUpperCase()}_NOT_FOUND`, `Runbook ${label} not found`));
  }
  const actorSessionId = context.actorSessionId;
  if (!actorSessionId) {
    return reply.code(422).send(errorPayload(
      "RUNBOOK_TARGET_HAS_NO_SESSION_PROVENANCE",
      "Runbook target has no session provenance",
    ));
  }

  try {
    const result = await mutate({
      actorKind: "user",
      actorSessionId,
      actorUserId: userId,
    });
    return {
      ok: true,
      runbookId: result.snapshot.runbook.id,
      eventId: result.eventId,
      idempotent: Boolean(result.idempotent),
      operation: result.operation,
      snapshot: result.snapshot,
    };
  } catch (error) {
    if (error instanceof RunbookVersionConflict) {
      return reply.code(409).send({
        detail: {
          error: {
            code: "RUNBOOK_VERSION_CONFLICT",
            message: error.message,
            details: {
              targetKind: error.targetKind,
              targetId: error.targetId,
              expectedVersion: error.expectedVersion,
              actualVersion: error.actualVersion,
            },
          },
        },
      });
    }
    request.log.error({ error }, "Runbook browser CRUD failed");
    return reply.code(500).send(errorPayload(
      "RUNBOOK_MUTATION_FAILED",
      error instanceof Error ? error.message : "Runbook mutation failed",
    ));
  }
}

function resolveTarget(
  snapshot: RunbookSnapshot,
  target: { kind: "runbook" | "section" | "item"; targetId?: string },
): { found: boolean; actorSessionId: string | null } {
  if (target.kind === "runbook") {
    return { found: true, actorSessionId: runbookSession(snapshot.runbook) };
  }
  if (target.kind === "section") {
    const section = snapshot.sections.find((candidate) => candidate.id === target.targetId);
    return section
      ? { found: true, actorSessionId: sectionSession(snapshot.runbook, section) }
      : { found: false, actorSessionId: null };
  }
  const item = snapshot.items.find((candidate) => candidate.id === target.targetId);
  if (!item) return { found: false, actorSessionId: null };
  const section = snapshot.sections.find((candidate) => candidate.id === item.section_id) ?? null;
  return { found: true, actorSessionId: itemSession(snapshot.runbook, section, item) };
}

function runbookSession(runbook: RunbookRow): string | null {
  return runbook.completed_session_id || runbook.created_session_id || null;
}

function sectionSession(runbook: RunbookRow, section: RunbookSectionRow): string | null {
  return section.assignee_session_id ||
    section.updated_session_id ||
    section.created_session_id ||
    runbookSession(runbook);
}

function itemSession(
  runbook: RunbookRow,
  section: RunbookSectionRow | null,
  item: RunbookItemRow,
): string | null {
  return item.assignee_session_id ||
    item.updated_session_id ||
    item.created_session_id ||
    (section ? sectionSession(runbook, section) : null) ||
    runbookSession(runbook);
}

function parseCreateSection(body: Body | undefined) {
  const common = parseCreate(body);
  if (!common.ok) return common;
  return success({
    ...common.value,
    sectionId: optionalString(body?.sectionId ?? body?.section_id) ?? undefined,
    afterSectionId: optionalString(body?.afterSectionId ?? body?.after_section_id),
    beforeSectionId: optionalString(body?.beforeSectionId ?? body?.before_section_id),
  });
}

function parseCreateItem(body: Body | undefined) {
  const common = parseCreate(body);
  if (!common.ok) return common;
  const howTo = body?.howTo ?? body?.how_to;
  if (howTo !== undefined && typeof howTo !== "string") return failure("howTo must be a string");
  return success({
    ...common.value,
    itemId: optionalString(body?.itemId ?? body?.item_id) ?? undefined,
    howTo: typeof howTo === "string" ? howTo : "",
    afterItemId: optionalString(body?.afterItemId ?? body?.after_item_id),
    beforeItemId: optionalString(body?.beforeItemId ?? body?.before_item_id),
  });
}

function parseCreate(body: Body | undefined) {
  const title = requiredString(body?.title, "title");
  if (!title.ok) return title;
  const idempotencyKey = requiredString(body?.idempotencyKey ?? body?.idempotency_key, "idempotencyKey");
  if (!idempotencyKey.ok) return idempotencyKey;
  return success({ title: title.value, idempotencyKey: idempotencyKey.value });
}

function parseUpdateSection(body: Body | undefined) {
  const versioned = parseVersioned(body);
  if (!versioned.ok) return versioned;
  const title = requiredString(body?.title, "title");
  if (!title.ok) return title;
  return success({ ...versioned.value, title: title.value });
}

function parseUpdateItem(body: Body | undefined) {
  const versioned = parseVersioned(body);
  if (!versioned.ok) return versioned;
  const rawTitle = body?.title;
  const rawHowTo = body?.howTo ?? body?.how_to;
  if (rawTitle === undefined && rawHowTo === undefined) return failure("title or howTo is required");
  const title = rawTitle === undefined ? undefined : requiredString(rawTitle, "title");
  if (title && !title.ok) return title;
  if (rawHowTo !== undefined && typeof rawHowTo !== "string") return failure("howTo must be a string");
  return success({
    ...versioned.value,
    title: title?.value,
    howTo: typeof rawHowTo === "string" ? rawHowTo : undefined,
  });
}

function parseMove(body: Body | undefined, kind: "section" | "item") {
  const versioned = parseVersioned(body);
  if (!versioned.ok) return versioned;
  const prefix = kind === "section" ? "Section" : "Item";
  return success({
    ...versioned.value,
    afterId: optionalString(body?.[`after${prefix}Id`] ?? body?.[`after_${kind}_id`]),
    beforeId: optionalString(body?.[`before${prefix}Id`] ?? body?.[`before_${kind}_id`]),
  });
}

function parseVersioned(body: Body | undefined) {
  const expectedVersion = body?.expectedVersion ?? body?.expected_version;
  if (typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion)) {
    return failure("expectedVersion must be an integer");
  }
  const idempotencyKey = requiredString(body?.idempotencyKey ?? body?.idempotency_key, "idempotencyKey");
  if (!idempotencyKey.ok) return idempotencyKey;
  const reasonValue = body?.reason;
  const reason = reasonValue === undefined || reasonValue === null
    ? null
    : optionalString(reasonValue);
  if (reasonValue !== undefined && reasonValue !== null && reason === null) {
    return failure("reason must be a non-empty string when supplied");
  }
  return success({ expectedVersion, idempotencyKey: idempotencyKey.value, reason });
}

function requiredString(value: unknown, label: string) {
  const parsed = optionalString(value);
  return parsed === null ? failure(`${label} is required`) : success(parsed);
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function success<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

function failure(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function invalid(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(422).send(errorPayload("INVALID_RUNBOOK_MUTATION", message));
}

function errorPayload(code: string, message: string) {
  return { detail: { error: { code, message } } };
}
