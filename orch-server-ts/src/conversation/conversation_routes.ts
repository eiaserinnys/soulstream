import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ConversationError, type EnsureRequest, type PatchRequest } from "./conversation_types.js";
import type { ConversationService } from "./conversation_service.js";

export const conversationRouteAuthRequirements = {
  "GET /api/conversations/v1/models": true,
  "GET /api/conversations/v1/threads": true,
  "GET /api/conversations/v1/threads/by-key": true,
  "PUT /api/conversations/v1/threads/by-key": true,
  "PUT /api/conversations/v1/threads/by-key/adoption": true,
  "GET /api/conversations/v1/threads/:id": true,
  "PATCH /api/conversations/v1/threads/:id": true,
} as const;
export type ConversationRouteOptions = { service: ConversationService; resolveAccount(request: FastifyRequest): Promise<string | null> };
export function registerConversationRoutes(app: FastifyInstance, options: ConversationRouteOptions): void {
  const wrap = (handler: (request: FastifyRequest, account: string) => Promise<unknown> | unknown) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const account = await options.resolveAccount(request);
        if (!account) throw new ConversationError(401, "login_required", "Authentication required");
        return reply.send(await handler(request, account));
      } catch (error) {
        if (error instanceof ConversationError) return reply.code(error.status).send({ error: { code: error.code, message: error.message },
          ...(error.threadId ? { thread_id: error.threadId } : {}) });
        const status = typeof error === "object" && error !== null && "statusCode" in error ? error.statusCode : undefined;
        if (status === 403 || status === 404) return reply.code(status).send({ error: { code: status === 403 ? "forbidden" : "not_found", message: status === 403 ? "Folder access denied" : "Thread not found" } });
        if (status === 422) {
          const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
          return reply.code(422).send({ error: { code: code === "INVALID_MODEL_PRESET" ? "model_unavailable" : "invalid_request", message: error instanceof Error ? error.message : "Invalid request" } });
        }
        request.log.warn({ err: error }, "conversation request failed");
        return reply.code(503).send({ error: { code: "unavailable", message: "Conversation service unavailable" } });
      }
    };
  app.get("/api/conversations/v1/models", wrap(() => options.service.models()));
  app.get("/api/conversations/v1/threads", wrap((r, a) => options.service.list(r, a, query(r, "namespace"), optionalQuery(r, "cursor"))));
  app.get("/api/conversations/v1/threads/by-key", wrap((r, a) => options.service.byKey(r, a, query(r, "namespace"), query(r, "key"))));
  app.put("/api/conversations/v1/threads/by-key", wrap((r, a) => options.service.ensure(r, a, query(r, "namespace"), query(r, "key"), ensureBody(r.body))));
  app.put("/api/conversations/v1/threads/by-key/adoption", wrap((r, a) => {
    const body = object(r.body); keys(body, ["session_id"]);
    return options.service.adopt(r, a, query(r, "namespace"), query(r, "key"), string(body.session_id, "session_id"));
  }));
  app.get("/api/conversations/v1/threads/:id", wrap((r, a) => options.service.info(r, a, param(r))));
  app.patch("/api/conversations/v1/threads/:id", wrap((r, a) => options.service.patch(r, a, param(r), patchBody(r.body))));
}
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("Body must be an object");
  return input as Record<string, unknown>;
}
function string(value: unknown, name: string, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim())) throw invalid(`${name} must be a ${empty ? "" : "non-empty "}string`);
  return value;
}
function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some(v => typeof v !== "string" || !v.trim())) throw invalid(`${name} must be an array of non-empty strings`);
  return value;
}
function keys(body: Record<string, unknown>, allowed: string[]) {
  const unknown = Object.keys(body).find(key => !allowed.includes(key));
  if (unknown) throw invalid(`${unknown} is not supported`);
}
function query(r: FastifyRequest, name: string) { return string((r.query as Record<string, unknown>)[name], name); }
function optionalQuery(r: FastifyRequest, name: string): string | undefined {
  const value = (r.query as Record<string, unknown>)[name]; return value === undefined ? undefined : string(value, name);
}
function param(r: FastifyRequest) { return string((r.params as Record<string, unknown>).id, "id"); }
function ensureBody(input: unknown): EnsureRequest {
  const b = object(input); keys(b, ["title", "selected_model", "model_order", "profile", "collection", "initial_instruction", "instructions"]);
  return { title: string(b.title, "title"), selected_model: string(b.selected_model, "selected_model"),
    model_order: strings(b.model_order, "model_order"), profile: string(b.profile, "profile"), collection: string(b.collection, "collection"),
    initial_instruction: string(b.initial_instruction, "initial_instruction", true), instructions: string(b.instructions, "instructions", true) };
}
function patchBody(input: unknown): PatchRequest {
  const b = object(input); keys(b, ["title", "archived", "model", "model_order", "instructions"]);
  if (b.archived !== undefined && b.archived !== true) throw invalid("archived must be true");
  return { ...(b.title === undefined ? {} : { title: string(b.title, "title") }),
    ...(b.archived === undefined ? {} : { archived: true }),
    ...(b.model === undefined ? {} : { model: string(b.model, "model") }),
    ...(b.model_order === undefined ? {} : { model_order: strings(b.model_order, "model_order") }),
    ...(b.instructions === undefined ? {} : { instructions: string(b.instructions, "instructions", true) }) };
}
function invalid(message: string) { return new ConversationError(400, "invalid_request", message); }
