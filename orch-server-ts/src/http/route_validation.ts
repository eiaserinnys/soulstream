import type { FastifyReply } from "fastify";
import { isRecord } from "@soulstream/wire-schema/json-record";

export type JsonObject = Record<string, unknown>;

export type Validation<T> =
  | { ok: true; value: T }
  | { ok: false; message: string; statusCode?: number };

export function jsonObjectOrUndefined(value: unknown): JsonObject | undefined {
  return isRecord(value) ? value : undefined;
}

export function parseObjectBody(
  body: unknown,
  options: { allowEmpty?: boolean } = {},
): Validation<JsonObject> {
  if (options.allowEmpty && (body === undefined || body === null)) {
    return { ok: true, value: {} };
  }
  if (isRecord(body)) return { ok: true, value: body };
  return { ok: false, message: "Request body must be a JSON object" };
}

export function requiredString(
  body: Record<string, unknown>,
  key: string,
): Validation<string> {
  const value = body[key];
  if (typeof value === "string") return { ok: true, value };
  return { ok: false, message: `${key} must be a string` };
}

export function requiredFiniteNumber(
  body: Record<string, unknown>,
  key: string,
): Validation<number> {
  const value = body[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return { ok: true, value };
  }
  return { ok: false, message: `${key} must be a number` };
}

export function requiredInteger(
  body: Record<string, unknown>,
  key: string,
): Validation<number> {
  const value = body[key];
  if (typeof value === "number" && Number.isInteger(value)) {
    return { ok: true, value };
  }
  return { ok: false, message: `${key} must be an integer` };
}

export function queryValue(query: unknown, key: string): unknown {
  if (typeof query !== "object" || query === null || !(key in query)) {
    return undefined;
  }
  const value = (query as Record<string, unknown>)[key];
  return Array.isArray(value) ? value[0] : value;
}

export function rawQueryValue(query: unknown, key: string): unknown {
  if (typeof query !== "object" || query === null || !(key in query)) {
    return undefined;
  }
  return (query as Record<string, unknown>)[key];
}

export function queryInteger(query: unknown, key: string): number | undefined {
  const value = queryValue(query, key);
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function optionalStringOrNull(
  body: Record<string, unknown>,
  key: string,
): Validation<string | null | undefined> {
  if (!hasOwn(body, key)) return { ok: true, value: undefined };
  const value = body[key];
  if (value === null || typeof value === "string") return { ok: true, value };
  return { ok: false, message: `${key} must be a string or null` };
}

export function optionalFiniteNumber(
  body: Record<string, unknown>,
  key: string,
): Validation<number | undefined> {
  const value = body[key];
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value === "number" && Number.isFinite(value)) {
    return { ok: true, value };
  }
  return { ok: false, message: `${key} must be a number` };
}

export function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ detail: message });
}

export function validationError<T>(
  reply: FastifyReply,
  validation: Extract<Validation<T>, { ok: false }>,
): FastifyReply {
  return reply.code(validation.statusCode ?? 400).send({ detail: validation.message });
}

export function folderAccessDenied(reply: FastifyReply): FastifyReply {
  return reply.code(403).send({ detail: "Folder access denied" });
}

export function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}
