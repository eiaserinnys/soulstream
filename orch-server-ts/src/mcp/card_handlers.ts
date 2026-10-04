import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { errorResultFromError, jsonResult, readOrchErrorEnvelopeText, type CallToolResult, type cardTools } from "@soulstream/mcp-contract";
import { listCardRouteBody, readCardRouteBody, mutateCardRouteBody, cardRouteErrorResponse } from "../cards/card_route_body.js";
import type { CardOperation } from "../cards/card_operations.js";
import type { McpCallContext, McpHostOptions } from "./types.js";

type Args = Record<string, unknown>;
type Options = McpHostOptions["cards"];
type Handler = (options: Pick<McpHostOptions, "cards">, args: Args, context: McpCallContext) => Promise<CallToolResult>;

export const cardHandlers = {
  create_card: (o, a, c) => run(async () => {
    const actor = agent(a, c);
    const assignee = !Object.hasOwn(a, "assignee") ? {} : { assignee: !a.assignee ? null : {
      kind: (a.assignee as Args).kind, agentId: (a.assignee as Args).agent_id,
      sessionId: (a.assignee as Args).session_id, userId: (a.assignee as Args).user_id,
    } };
    return mutation(o.cards, "create_card", undefined, { folderId: a.folder_id, title: a.title, request: a.request, brief: a.brief,
      attachments: a.attachments, ...assignee, nodeId: a.node_id, modelPreset: a.model_preset, queue: a.queue,
      idempotencyKey: a.idempotency_key ?? randomUUID() }, actor);
  }),
  list_cards: (o, a) => run(() => request(() => listCardRouteBody(o.cards,
    { folderId: a.folder_id, status: a.status }, o.cards.resolveAccess))),
  get_card: (o, a) => run(() => read(o.cards, String(a.card_id))),
  update_card_brief: (o, a, c) => append(o.cards, "update_card", a, c, { brief: a.brief }, true),
  add_card_report: (o, a, c) => append(o.cards, "add_card_report", a, c, { title: a.title, format: a.format, body: a.body }),
  add_card_comment: (o, a, c) => run(async () => {
    if (a.mode === "reply") matchingHeader(a, c);
    return appendMutation(o.cards, "add_card_comment", a, agent(a, c), { body: a.text, ...(c.principal === "external" ? (a.mode === undefined ? {} : { mode: a.mode }) : { mode: a.mode ?? "spoken" }) });
  }),
  set_card_status: (o, a, c) => run(async () => {
    matchingHeader(a, c);
    return mutation(o.cards, "set_card_status", String(a.card_id), {
      status: a.status, expectedVersion: a.expected_version, idempotencyKey: a.idempotency_key, reason: a.reason,
    }, agent(a, c, true));
  }),
  transfer_card_assignee: (o, a, c) => run(async () => {
    if (c.principal === "external") throw new Error("card mutation requires an agent session");
    if (!c.callerSessionId) throw new Error("authenticated request session header is required for card assignee handoff");
    matchingHeader(a, c);
    const actor = agent(a, c, true);
    if (actor.actorKind !== "agent" || actor.actorSessionId !== c.callerSessionId)
      throw new Error("card assignee handoff requires the authenticated agent session");
    return mutation(o.cards, "update_card", String(a.card_id), {
      assignee: { kind: "session", sessionId: a.target_session_id },
      expectedVersion: a.expected_version, idempotencyKey: a.idempotency_key, reason: a.reason,
    }, actor);
  }),
  start_card_work: (o, a, c) => run(async () => {
    if (c.principal === "external") throw new Error("card mutation requires an agent session");
    matchingHeader(a, c);
    const actor = agent(a, c, true);
    if (!c.execution) throw new Error("Current work execution required; orchestration purpose cannot start work");
    return mutation(o.cards, "start_card_work", String(a.card_id), {
      expectedVersion: a.expected_version, idempotencyKey: a.idempotency_key, reason: a.reason, execution: c.execution,
    }, actor);
  }),
  request_card_review: (o, a, c) => append(o.cards, "set_card_status", a, c, { status: "review" }, true),
  ask_card_question: (o, a, c) => run(async () => {
    const result = await appendMutation(o.cards, "ask_card_question", a, agent(a, c), {
      text: a.text, ...(a.options !== undefined ? { options: a.options } : {}),
    });
    return { ...result, guidance: "질문이 등록되었다. 이 턴을 끝내고 답을 기다린다." };
  }),
  move_card: (o, a, c) => append(o.cards, "move_card", a, c, {
    folderId: a.folder_id, ...(a.after_card_id !== undefined ? { afterCardId: a.after_card_id } : {}),
  }, true),
} satisfies Record<keyof typeof cardTools, Handler>;

function matchingHeader(args: Args, context: McpCallContext) {
  if (context.principal !== "external" && context.callerSessionId && args.caller_session_id && String(args.caller_session_id).trim() !== context.callerSessionId)
    throw new Error("caller_session_id must match the authenticated request session header");
}
function agent(args: Args, context: McpCallContext, headerFirst = false) {
  if (context.principal === "external") return { actorKind: "llm" as const, actorSessionId: null };
  const explicit = typeof args.caller_session_id === "string" ? args.caller_session_id.trim() : "";
  const actorSessionId = headerFirst ? context.callerSessionId ?? (explicit || undefined) : explicit || context.callerSessionId;
  if (!actorSessionId) throw new Error("caller session id is required for card mutation. Send x-soulstream-agent-session-id.");
  return { actorKind: "agent" as const, actorSessionId };
}
async function append(options: Options, operation: CardOperation, args: Args, context: McpCallContext, body: Args, cas = false) {
  return run(() => appendMutation(options, operation, args, agent(args, context), body, cas));
}
async function appendMutation(options: Options, operation: CardOperation, args: Args, actor: ReturnType<typeof agent>, body: Args, cas = false) {
  const expected = cas ? { expectedVersion: ((await read(options, String(args.card_id))) as { card: { version: number } }).card.version } : {};
  return mutation(options, operation, String(args.card_id), { ...body, ...expected, idempotencyKey: randomUUID() }, actor);
}
async function mutation(options: Options, operation: CardOperation, cardId: string | undefined, body: Args, actor: ReturnType<typeof agent>) {
  return request(async () => (await mutateCardRouteBody(options, operation, cardId,
    JSON.parse(JSON.stringify(body)), options.resolveAccess, () => actor)).body);
}
async function read(options: Options, cardId: string) {
  return request(() => readCardRouteBody(options, cardId, options.resolveAccess));
}
async function request(fn: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try { return JSON.parse(JSON.stringify(await fn())) as Record<string, unknown>; }
  catch (error) {
    const response = cardRouteErrorResponse(error);
    const failure = readOrchErrorEnvelopeText({ status: response.status, statusText: STATUS_CODES[response.status] ?? "" }, JSON.stringify(response.body));
    throw Object.assign(new Error(failure.message), { statusCode: response.status, code: failure.code });
  }
}
async function run(fn: () => Promise<unknown>) {
  try { return jsonResult(await fn()); }
  catch (error) { return errorResultFromError(error); }
}
