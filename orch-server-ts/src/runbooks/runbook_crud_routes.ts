import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  loadRunbookSnapshot,
  proxyRunbookMutation,
  requireSnapshotAccess,
  sendRunbookRouteError,
} from "./runbook_mutation_proxy.js";
import {
  resolveItemActorSessionId,
  resolveRunbookActorSessionId,
  resolveSectionActorSessionId,
  snapshotItem,
  snapshotSection,
} from "./runbook_snapshot.js";
import type { RunbookRouteOptions, RunbookSnapshot } from "./runbook_route_types.js";

type CrudOperation =
  | "create_section"
  | "update_section"
  | "move_section"
  | "archive_section"
  | "create_item"
  | "update_item"
  | "move_item"
  | "archive_item";

interface CrudRoute {
  operation: CrudOperation;
  path: string;
}

type Params = {
  runbook_id: string;
  section_id?: string;
  item_id?: string;
};

type Validation<T> = { ok: true; value: T } | { ok: false; message: string };

const routes: readonly CrudRoute[] = [
  { operation: "create_section", path: "/api/runbooks/:runbook_id/sections" },
  { operation: "update_section", path: "/api/runbooks/:runbook_id/sections/:section_id" },
  { operation: "move_section", path: "/api/runbooks/:runbook_id/sections/:section_id/move" },
  { operation: "archive_section", path: "/api/runbooks/:runbook_id/sections/:section_id/archive" },
  { operation: "create_item", path: "/api/runbooks/:runbook_id/sections/:section_id/items" },
  { operation: "update_item", path: "/api/runbooks/:runbook_id/items/:item_id" },
  { operation: "move_item", path: "/api/runbooks/:runbook_id/items/:item_id/move" },
  { operation: "archive_item", path: "/api/runbooks/:runbook_id/items/:item_id/archive" },
];

export function registerRunbookCrudRoutes(
  app: FastifyInstance,
  options: RunbookRouteOptions,
): void {
  for (const route of routes) {
    app.post<{ Params: Params }>(route.path, async (request, reply) => {
      const body = validateBody(route.operation, request.body);
      if (!body.ok) return reply.code(400).send({ detail: body.message });

      const snapshotResult = await loadRunbookSnapshot(
        options.provider,
        request.params.runbook_id,
      );
      if (!snapshotResult.ok) return sendRunbookRouteError(reply, snapshotResult.error);
      const snapshot = snapshotResult.value;
      const accessResult = await requireSnapshotAccess(options, request, snapshot);
      if (!accessResult.ok) return sendRunbookRouteError(reply, accessResult.error);

      const actorResult = actorSessionFor(route.operation, snapshot, request.params);
      if (!actorResult.ok) return reply.code(actorResult.statusCode).send({ detail: actorResult.message });

      return proxyRunbookMutation(request, reply, options, actorResult.actorSessionId, {
        upstreamPath: upstreamPath(route.operation, request.params),
        body: body.value,
      });
    });
  }
}

function actorSessionFor(
  operation: CrudOperation,
  snapshot: RunbookSnapshot,
  params: Params,
): { ok: true; actorSessionId: string } | { ok: false; statusCode: number; message: string } {
  if (operation === "create_section") {
    return actorResult(resolveRunbookActorSessionId(snapshot), "Runbook");
  }
  if (operation.includes("section") || operation === "create_item") {
    const sectionId = params.section_id ?? "";
    if (snapshotSection(snapshot, sectionId) === undefined) {
      return { ok: false, statusCode: 404, message: "Runbook section not found" };
    }
    return actorResult(resolveSectionActorSessionId(snapshot, sectionId), "Runbook section");
  }
  const itemId = params.item_id ?? "";
  if (snapshotItem(snapshot, itemId) === undefined) {
    return { ok: false, statusCode: 404, message: "Runbook item not found" };
  }
  return actorResult(resolveItemActorSessionId(snapshot, itemId), "Runbook item");
}

function actorResult(
  actorSessionId: string | null,
  label: string,
): { ok: true; actorSessionId: string } | { ok: false; statusCode: number; message: string } {
  return actorSessionId === null
    ? { ok: false, statusCode: 422, message: `${label} has no session provenance` }
    : { ok: true, actorSessionId };
}

function validateBody(operation: CrudOperation, body: unknown): Validation<Record<string, unknown>> {
  const object = objectBody(body);
  if (!object.ok) return object;
  const value = object.value;
  const idempotency = requiredStringAlias(value, "idempotencyKey", "idempotency_key");
  if (!idempotency.ok || idempotency.value.trim().length === 0) {
    return { ok: false, message: "idempotencyKey must be a non-empty string" };
  }

  if (operation.startsWith("create_") || operation.startsWith("update_")) {
    const titleRequired = operation === "create_section" ||
      operation === "create_item" ||
      operation === "update_section";
    if (titleRequired) {
      const title = requiredString(value, "title");
      if (!title.ok || title.value.trim().length === 0) {
        return { ok: false, message: "title must be a non-empty string" };
      }
    }
    if (operation === "update_item" && value.title !== undefined) {
      const title = requiredString(value, "title");
      if (!title.ok || title.value.trim().length === 0) {
        return { ok: false, message: "title must be a non-empty string" };
      }
    }
    const howTo = value.howTo ?? value.how_to;
    if (howTo !== undefined && typeof howTo !== "string") {
      return { ok: false, message: "howTo must be a string" };
    }
    if (operation === "update_item" && value.title === undefined && howTo === undefined) {
      return { ok: false, message: "title or howTo is required" };
    }
  }

  if (!operation.startsWith("create_")) {
    const version = value.expectedVersion ?? value.expected_version;
    if (typeof version !== "number" || !Number.isInteger(version)) {
      return { ok: false, message: "expectedVersion must be an integer" };
    }
  }
  return { ok: true, value };
}

function upstreamPath(operation: CrudOperation, params: Params): string {
  const runbook = encodeURIComponent(params.runbook_id);
  const section = encodeURIComponent(params.section_id ?? "");
  const item = encodeURIComponent(params.item_id ?? "");
  switch (operation) {
    case "create_section": return `/api/runbooks/${runbook}/sections`;
    case "update_section": return `/api/runbooks/${runbook}/sections/${section}`;
    case "move_section": return `/api/runbooks/${runbook}/sections/${section}/move`;
    case "archive_section": return `/api/runbooks/${runbook}/sections/${section}/archive`;
    case "create_item": return `/api/runbooks/${runbook}/sections/${section}/items`;
    case "update_item": return `/api/runbooks/${runbook}/items/${item}`;
    case "move_item": return `/api/runbooks/${runbook}/items/${item}/move`;
    case "archive_item": return `/api/runbooks/${runbook}/items/${item}/archive`;
  }
}

function objectBody(body: unknown): Validation<Record<string, unknown>> {
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? { ok: true, value: body as Record<string, unknown> }
    : { ok: false, message: "Request body must be a JSON object" };
}

function requiredString(
  body: Record<string, unknown>,
  key: string,
): Validation<string> {
  return typeof body[key] === "string"
    ? { ok: true, value: body[key] }
    : { ok: false, message: `${key} must be a string` };
}

function requiredStringAlias(
  body: Record<string, unknown>,
  camelKey: string,
  snakeKey: string,
): Validation<string> {
  return requiredString(body, body[camelKey] !== undefined ? camelKey : snakeKey);
}
