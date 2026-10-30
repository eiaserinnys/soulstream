import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ConversationError, type EnsureRequest, type PatchRequest } from "./conversation_types.js";
import type { ConversationService } from "./conversation_service.js";
import { ConversationHistory } from "./conversation_history.js";
import { sendConversationEvents } from "./conversation_events.js";
import type { SessionHistoryLiveEventSource } from "../session/session_history_routes.js";

export const conversationRouteAuthRequirements = {
  "GET /api/conversations/v1/models": true,
  "GET /api/conversations/v1/threads": true,
  "GET /api/conversations/v1/threads/by-key": true,
  "PUT /api/conversations/v1/threads/by-key": true,
  "PUT /api/conversations/v1/threads/by-key/adoption": true,
  "GET /api/conversations/v1/threads/:id": true,
  "GET /api/conversations/v1/threads/:id/items": true,
  "GET /api/conversations/v1/threads/:id/events": true,
  "PATCH /api/conversations/v1/threads/:id": true,
} as const;
export type ConversationRouteOptions = { service: ConversationService; resolveAccount(request: FastifyRequest): Promise<string | null>; liveEvents?: SessionHistoryLiveEventSource; closeAfterHistorySync?: boolean };
export function registerConversationRoutes(app: FastifyInstance, options: ConversationRouteOptions): void {
  const history = new ConversationHistory(options.service.historySql);
  const wrap = (handler: (request: FastifyRequest, account: string, reply: FastifyReply) => Promise<unknown> | unknown) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const account = await options.resolveAccount(request);
        if (!account) throw new ConversationError(401, "login_required", "Authentication required");
        const result = await handler(request, account, reply);
        if (reply.sent || reply.raw.headersSent) return;
        return reply.send(result);
      } catch (error) {
        return sendConversationError(request, reply, error);
      }
    };
  app.get("/api/conversations/v1/models", wrap(() => options.service.models()));
  app.get("/api/conversations/v1/threads", wrap((r, a) => options.service.list(r, a, query(r, "namespace"), optionalQuery(r, "cursor"))));
  app.get("/api/conversations/v1/threads/by-key", wrap((r, a) => options.service.byKey(r, a, query(r, "namespace"), query(r, "key"))));
  app.put("/api/conversations/v1/threads/by-key", wrap((r, a) => options.service.ensure(r, a, query(r, "namespace"), query(r, "key"), ensureBody(r.body))));
  app.put("/api/conversations/v1/threads/by-key/adoption", wrap((r, a) => {
    const body = object(r.body); keys(body, ["session_id", "first_input_is_initial_instruction"]);
    if (body.first_input_is_initial_instruction !== undefined && typeof body.first_input_is_initial_instruction !== "boolean") throw invalid("first_input_is_initial_instruction must be a boolean");
    return options.service.adopt(r, a, query(r, "namespace"), query(r, "key"), string(body.session_id, "session_id"), body.first_input_is_initial_instruction === true);
  }));
  app.get("/api/conversations/v1/threads/:id", wrap((r, a) => options.service.info(r, a, param(r))));
  app.get("/api/conversations/v1/threads/:id/items", wrap(async (r, a) => {
    const binding = await options.service.historyBinding(r, a, param(r));
    const raw = optionalQuery(r, "limit");
    if (raw !== undefined && (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 200)) throw invalid("limit must be between 1 and 200");
    return history.items(binding, optionalQuery(r, "before"), raw === undefined ? 200 : Number(raw));
  }));
  app.get("/api/conversations/v1/threads/:id/events", async (request, reply) => {
    let binding;
    try {
      const account = await options.resolveAccount(request);
      if (!account) throw new ConversationError(401, "login_required", "Authentication required");
      binding = await options.service.historyBinding(request, account, param(request));
    } catch (error) {
      return sendConversationError(request, reply, error);
    }
    return sendConversationEvents(request, reply, history, binding, options);
  });
  app.patch("/api/conversations/v1/threads/:id", wrap((r, a) => options.service.patch(r, a, param(r), patchBody(r.body))));
}
function sendConversationError(request: FastifyRequest, reply: FastifyReply, error: unknown) {
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
