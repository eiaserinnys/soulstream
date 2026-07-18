import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  authenticateDashboardHttpRequest,
  type BoardYjsAuthConfig,
} from "../collaboration/board_yjs_auth.js";
import type {
  TaskItemRow,
  TaskRow,
  TaskSectionRow,
  TaskSnapshot,
} from "../db/session_db_types.js";

import { TaskVersionConflict } from "./task_models.js";
import type { TaskService } from "./task_service.js";

interface TaskCrudHttpConfig {
  service: TaskService;
  auth: BoardYjsAuthConfig;
}

interface TaskParams {
  taskId: string;
}

interface SectionParams extends TaskParams {
  sectionId: string;
}

interface ItemParams extends TaskParams {
  itemId: string;
}

interface CreateItemParams extends SectionParams {}

type Body = Record<string, unknown>;

type UserActor = {
  actorKind: "user";
  actorSessionId: string;
  actorUserId: string;
};

export function registerTaskCrudHttpRoutes(
  fastify: FastifyInstance,
  config: TaskCrudHttpConfig,
): void {
  fastify.post<{ Params: TaskParams; Body: Body }>(
    "/api/tasks/:taskId/sections",
    async (request, reply) => {
      const parsed = parseCreateSection(request.body);
      if (!parsed.ok) return invalid(reply, parsed.error);
      return runMutation(request, reply, config, { kind: "task" }, async (actor) =>
        await config.service.createSection({
          ...actor,
          taskId: request.params.taskId,
          sectionId: parsed.value.sectionId,
          title: parsed.value.title,
          afterSectionId: parsed.value.afterSectionId,
          beforeSectionId: parsed.value.beforeSectionId,
          idempotencyKey: parsed.value.idempotencyKey,
        }));
    },
  );

  fastify.post<{ Params: SectionParams; Body: Body }>(
    "/api/tasks/:taskId/sections/:sectionId",
    async (request, reply) => {
      const parsed = parseUpdateSection(request.body);
      if (!parsed.ok) return invalid(reply, parsed.error);
      return runMutation(request, reply, config, {
        kind: "section",
        targetId: request.params.sectionId,
      }, async (actor) => await config.service.patchSection({
        ...actor,
        taskId: request.params.taskId,
        sectionId: request.params.sectionId,
        expectedVersion: parsed.value.expectedVersion,
        title: parsed.value.title,
        reason: parsed.value.reason,
        idempotencyKey: parsed.value.idempotencyKey,
      }));
    },
  );

  fastify.post<{ Params: SectionParams; Body: Body }>(
    "/api/tasks/:taskId/sections/:sectionId/move",
    async (request, reply) => {
      const parsed = parseMove(request.body, "section");
      if (!parsed.ok) return invalid(reply, parsed.error);
      return runMutation(request, reply, config, {
        kind: "section",
        targetId: request.params.sectionId,
      }, async (actor) => await config.service.moveSection({
        ...actor,
        taskId: request.params.taskId,
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
    "/api/tasks/:taskId/sections/:sectionId/archive",
    async (request, reply) => {
      const parsed = parseVersioned(request.body);
      if (!parsed.ok) return invalid(reply, parsed.error);
      return runMutation(request, reply, config, {
        kind: "section",
        targetId: request.params.sectionId,
      }, async (actor) => await config.service.patchSection({
        ...actor,
        taskId: request.params.taskId,
        sectionId: request.params.sectionId,
        expectedVersion: parsed.value.expectedVersion,
        archived: true,
        reason: parsed.value.reason,
        idempotencyKey: parsed.value.idempotencyKey,
      }));
    },
  );

  fastify.post<{ Params: CreateItemParams; Body: Body }>(
    "/api/tasks/:taskId/sections/:sectionId/items",
    async (request, reply) => {
      const parsed = parseCreateItem(request.body);
      if (!parsed.ok) return invalid(reply, parsed.error);
      return runMutation(request, reply, config, {
        kind: "section",
        targetId: request.params.sectionId,
      }, async (actor) => await config.service.createItem({
        ...actor,
        taskId: request.params.taskId,
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
    "/api/tasks/:taskId/items/:itemId",
    async (request, reply) => {
      const parsed = parseUpdateItem(request.body);
      if (!parsed.ok) return invalid(reply, parsed.error);
      return runMutation(request, reply, config, {
        kind: "item",
        targetId: request.params.itemId,
      }, async (actor) => await config.service.patchItem({
        ...actor,
        taskId: request.params.taskId,
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
    "/api/tasks/:taskId/items/:itemId/move",
    async (request, reply) => {
      const parsed = parseMove(request.body, "item");
      if (!parsed.ok) return invalid(reply, parsed.error);
      return runMutation(request, reply, config, {
        kind: "item",
        targetId: request.params.itemId,
      }, async (actor) => await config.service.moveItem({
        ...actor,
        taskId: request.params.taskId,
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
    "/api/tasks/:taskId/items/:itemId/archive",
    async (request, reply) => {
      const parsed = parseVersioned(request.body);
      if (!parsed.ok) return invalid(reply, parsed.error);
      return runMutation(request, reply, config, {
        kind: "item",
        targetId: request.params.itemId,
      }, async (actor) => await config.service.patchItem({
        ...actor,
        taskId: request.params.taskId,
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
  request: FastifyRequest<{ Params: TaskParams }>,
  reply: FastifyReply,
  config: TaskCrudHttpConfig,
  target: { kind: "task" | "section" | "item"; targetId?: string },
  mutate: (actor: UserActor) => Promise<{
    snapshot: TaskSnapshot;
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

  const snapshot = await config.service.getTask(request.params.taskId);
  if (!snapshot) return reply.code(404).send(errorPayload("TASK_NOT_FOUND", "Task not found"));
  const context = resolveTarget(snapshot, target);
  if (!context.found) {
    const label = target.kind === "item" ? "item" : "section";
    return reply.code(404).send(errorPayload(`TASK_${label.toUpperCase()}_NOT_FOUND`, `Task ${label} not found`));
  }
  const actorSessionId = context.actorSessionId;
  if (!actorSessionId) {
    return reply.code(422).send(errorPayload(
      "TASK_TARGET_HAS_NO_SESSION_PROVENANCE",
      "Task target has no session provenance",
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
      taskId: result.snapshot.task.id,
      eventId: result.eventId,
      idempotent: Boolean(result.idempotent),
      operation: result.operation,
      snapshot: result.snapshot,
    };
  } catch (error) {
    if (error instanceof TaskVersionConflict) {
      return reply.code(409).send({
        detail: {
          error: {
            code: "TASK_VERSION_CONFLICT",
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
    request.log.error({ error }, "Task browser CRUD failed");
    return reply.code(500).send(errorPayload(
      "TASK_MUTATION_FAILED",
      error instanceof Error ? error.message : "Task mutation failed",
    ));
  }
}

function resolveTarget(
  snapshot: TaskSnapshot,
  target: { kind: "task" | "section" | "item"; targetId?: string },
): { found: boolean; actorSessionId: string | null } {
  if (target.kind === "task") {
    return { found: true, actorSessionId: taskSession(snapshot.task) };
  }
  if (target.kind === "section") {
    const section = snapshot.sections.find((candidate) => candidate.id === target.targetId);
    return section
      ? { found: true, actorSessionId: sectionSession(snapshot.task, section) }
      : { found: false, actorSessionId: null };
  }
  const item = snapshot.items.find((candidate) => candidate.id === target.targetId);
  if (!item) return { found: false, actorSessionId: null };
  const section = snapshot.sections.find((candidate) => candidate.id === item.section_id) ?? null;
  return { found: true, actorSessionId: itemSession(snapshot.task, section, item) };
}

function taskSession(task: TaskRow): string | null {
  return task.completed_session_id || task.created_session_id || null;
}

function sectionSession(task: TaskRow, section: TaskSectionRow): string | null {
  return section.assignee_session_id ||
    section.updated_session_id ||
    section.created_session_id ||
    taskSession(task);
}

function itemSession(
  task: TaskRow,
  section: TaskSectionRow | null,
  item: TaskItemRow,
): string | null {
  return item.assignee_session_id ||
    item.updated_session_id ||
    item.created_session_id ||
    (section ? sectionSession(task, section) : null) ||
    taskSession(task);
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
  return reply.code(422).send(errorPayload("INVALID_TASK_MUTATION", message));
}

function errorPayload(code: string, message: string) {
  return { detail: { error: { code, message } } };
}
