import { ConversationMessageService, MESSAGE_BODY_LIMIT } from "./conversation_messages.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ConversationError, type EnsureRequest, type PatchRequest } from "./conversation_types.js";
import type { ConversationService } from "./conversation_service.js";
import { ConversationHistory } from "./conversation_history.js";
import { sendConversationEvents } from "./conversation_events.js";
import { parsePosition } from "./conversation_position.js";
import type { SessionHistoryLiveEventSource } from "../session/session_history_routes.js";

export const conversationRouteAuthRequirements = {
  "GET /api/conversations/v1/models": true,
  "GET /api/conversations/v1/profiles": true,
  "GET /api/conversations/v1/threads": true,
  "GET /api/conversations/v1/threads/by-key": true,
  "PUT /api/conversations/v1/threads/by-key": true,
  "PUT /api/conversations/v1/threads/by-key/adoption": true,
  "GET /api/conversations/v1/threads/:id": true,
  "PUT /api/conversations/v1/threads/:id/execution": true,
  "GET /api/conversations/v1/threads/:id/items": true,
  "GET /api/conversations/v1/threads/:id/events": true,
  "PATCH /api/conversations/v1/threads/:id": true,
  "POST /api/conversations/v1/threads/:id/messages": true,
  "GET /api/conversations/v1/threads/:id/messages/:request_id": true,
  "GET /api/conversations/v1/threads/:id/items/:item_id/attachments/:attachment_id": true,
} as const;
export type ConversationRouteOptions = { messages?: ConversationMessageService; service: ConversationService; resolveAccount(request: FastifyRequest): Promise<string | null>; liveEvents?: SessionHistoryLiveEventSource; closeAfterHistorySync?: boolean };
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
  app.get("/api/conversations/v1/models", wrap(r => options.service.models(optionalQuery(r, "profile"))));
  app.get("/api/conversations/v1/profiles", wrap(() => options.service.profiles()));
  app.get("/api/conversations/v1/threads", wrap((r, a) => options.service.list(r, a, query(r, "namespace"), optionalQuery(r, "cursor"))));
  app.get("/api/conversations/v1/threads/by-key", wrap((r, a) => options.service.byKey(r, a, query(r, "namespace"), query(r, "key"))));
  app.put("/api/conversations/v1/threads/by-key", wrap((r, a) => options.service.ensure(r, a, query(r, "namespace"), query(r, "key"), ensureBody(r.body))));
  app.put("/api/conversations/v1/threads/by-key/adoption", wrap((r, a) => {
    const body = object(r.body); keys(body, ["session_id", "first_input_is_initial_instruction"]);
    if (body.first_input_is_initial_instruction !== undefined && typeof body.first_input_is_initial_instruction !== "boolean") throw invalid("first_input_is_initial_instruction must be a boolean");
    return options.service.adopt(r, a, query(r, "namespace"), query(r, "key"), string(body.session_id, "session_id"), body.first_input_is_initial_instruction === true);
  }));
  app.get("/api/conversations/v1/threads/:id", wrap((r, a) => options.service.info(r, a, param(r))));
  app.put("/api/conversations/v1/threads/:id/execution", wrap((r,a) => {
    const body = object(r.body);
    const {expected_execution_id, ...rest} = body;
    return options.service.switchExecution(r, a, param(r), { ...ensureBody(rest), expected_execution_id:string(expected_execution_id, "expected_execution_id") });
  }));
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
    return sendConversationEvents(request, reply, history, binding, { ...options, watchSwitch:(id, close) => options.service.watchSwitch(id, close) });
  });
  const messageService = () => {
    if (!options.messages) throw new ConversationError(503,"unavailable","Message service unavailable");
    return options.messages;
  };
  app.post("/api/conversations/v1/threads/:id/messages", { bodyLimit:MESSAGE_BODY_LIMIT, errorHandler(error,request,reply) {
    if (error.statusCode === 413) return reply.code(413).send({error:{code:"attachment_limit",message:"Attachment limit exceeded"}});
    if (error.statusCode === 400) return reply.code(400).send({error:{code:"invalid_request",message:"Invalid message"}});
    return sendConversationError(request,reply,error);
  } }, wrap(async (r,a) => {
    const id=param(r);
    const admitted = await options.service.withThread(r,a,id,binding => messageService().admit(r,id,r.body,binding.active_session_id ?? id,
      target => options.service.requireExecutionAccess(r,target)));
    return admitted.result;
  }));
  app.get("/api/conversations/v1/threads/:id/messages/:request_id", wrap(async (r,a) => {
    const id=param(r); await options.service.historyBinding(r,a,id);
    return await messageService().get(id,string((r.params as Record<string,unknown>).request_id,"request_id"));
  }));
  app.get("/api/conversations/v1/threads/:id/items/:item_id/attachments/:attachment_id", wrap(async (r,a,reply) => {
    const id=param(r), binding=await options.service.historyBinding(r,a,id);
    const params=r.params as Record<string,unknown>;
    const itemId=string(params.item_id,"item_id"), attachmentId=string(params.attachment_id,"attachment_id");
    const loaded=await history.load(binding);
    const entry=loaded.items.find(x => x.item.id === itemId);
    const item=entry?.item;
    const attachment=item?.attachments.find(x => x.id === attachmentId);
    if (!attachment || !entry) throw new ConversationError(404,"not_found","Attachment not found");
    await options.service.requireExecutionAccess(r,entry.session);
    let reference:{path?:string;assetId?:string};
    if (attachmentId.startsWith("path:")) {
      const indexText=attachmentId.slice(5);
      if (!/^\d+$/.test(indexText)) throw new ConversationError(404,"not_found","Attachment not found");
      const eventId = parsePosition(itemId)?.id;
      const [event]=await options.service.historySql<Array<{payload:Record<string,unknown>}>>`SELECT payload FROM events WHERE session_id=${entry.session} AND id=${eventId}`;
      const values=Array.isArray(event?.payload?.attachments) ? event.payload.attachments : event?.payload?.attachment_paths;
      const path=Array.isArray(values) ? values[Number(indexText)] : undefined;
      if (typeof path !== "string") throw new ConversationError(404,"not_found","Attachment not found");
      reference={path};
    } else reference={assetId:attachmentId};
    const data=await messageService().ports.read(r,entry.session,reference);
    if (!data.ok) throw new ConversationError(503,"unavailable","Attachment unavailable");
    const name=attachment.name.replace(/[^\x20-\x7e]|["\\]/g,"_");
    const encoded=encodeURIComponent(attachment.name).replace(/['()*]/g,c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    reply.header("Cache-Control","private, no-store").header("Content-Disposition",`attachment; filename="${name}"; filename*=UTF-8''${encoded}`);
    reply.header("X-Content-Type-Options","nosniff");
    reply.type(attachment.mime.replace(/[\r\n]/g,"") || "application/octet-stream");
    return reply.send(Buffer.from(await data.arrayBuffer()));
  }));
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
