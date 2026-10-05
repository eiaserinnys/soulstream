import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { errorResultFromError, jsonResult, readOrchErrorEnvelopeText, type CallToolResult, type cardTools } from "@soulstream/mcp-contract";
import { listCardRouteBody, readCardRouteBody, mutateCardRouteBody, cardRouteErrorResponse } from "../cards/card_route_body.js";
import { serializeCardRow } from "../folders/folder_contracts.js";
import type { CardOperation } from "../cards/card_operations.js";
import type { FolderActorParams } from "../cards/control_plane/card_types.js";
import type { McpCallContext, McpHostOptions } from "./types.js";

type Args = Record<string, unknown>;
type Options = McpHostOptions["cards"];
type Handler = (options: Pick<McpHostOptions, "cards">, args: Args, context: McpCallContext) => Promise<CallToolResult>;

export const cardHandlers = {
  create_card: (o, a, c) => run(async () => {
    if (a.run === true && a.queue === true) throw new Error("run과 queue는 함께 쓸 수 없습니다");
    const actor = agent(a, c);
    const assignee = !Object.hasOwn(a, "assignee") ? {} : { assignee: !a.assignee ? null : {
      kind: (a.assignee as Args).kind, agentId: (a.assignee as Args).agent_id,
      sessionId: (a.assignee as Args).session_id, userId: (a.assignee as Args).user_id,
    } };
    const created = await mutation(o.cards, "create_card", undefined, { folderId: a.folder_id, title: a.title, request: a.request, brief: a.brief,
      attachments: a.attachments, ...assignee, nodeId: a.node_id, modelPreset: a.model_preset, queue: a.queue,
      idempotencyKey: a.idempotency_key ?? randomUUID() }, actor);
    if (a.run !== true) return compactMutation(created);
    const card = created.card as { id: string; status: string } | null;
    if (created.idempotent === true && card && card.status !== "todo" && card.status !== "queued") return compactMutation(created);
    const cardId = String(card?.id ?? (created.operation as Args).targetId);
    try {
      const execution = await runCard(o.cards, cardId, actor, c.signal);
      return compactExecution(execution, created.idempotent === true);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw Object.assign(new Error(`카드 ${cardId}는 드래프트로 만들어졌지만 실행하지 못했습니다: ${reason}. 설정을 확인한 뒤 run_card로 실행하세요.`),
        { statusCode: (error as { statusCode?: number })?.statusCode ?? 422, code: (error as { code?: string })?.code ?? "CARD_EXECUTION_ERROR" });
    }
  }),
  run_card: (o, a, c) => run(async () => {
    matchingHeader(a, c);
    return compactExecution(await runCard(o.cards, String(a.card_id), agent(a, c, true), c.signal));
  }),
  list_cards: (o, a) => run(() => request(() => listCardRouteBody(o.cards,
    { folderId: a.folder_id, status: a.status }, o.cards.resolveAccess))),
  get_card: (o, a) => run(async () => {
    const detail=await read(o.cards,String(a.card_id)) as Record<string,unknown>;
    const notes=Array.isArray(detail.notes)?detail.notes.slice(-20):[];
    return {...detail,notes};
  }),
  update_card_brief: (o, a, c) => append(o.cards, "update_card", a, c, { brief: a.brief }, true),
  add_card_report: (o, a, c) => append(o.cards, "add_card_report", a, c, { title: a.title, format: a.format, body: a.body }),
  add_card_comment: (o, a, c) => run(async () => {
    if (a.mode === "reply") matchingHeader(a, c);
    return compactComment(await appendMutation(o.cards, "add_card_comment", a, agent(a, c), { body: a.text, mode:a.mode,itemId:a.item_id }));
  }),
  set_card_status: (o, a, c) => run(async () => {
    matchingHeader(a, c);
    return compactMutation(await mutation(o.cards, "set_card_status", String(a.card_id), {
      status: a.status, expectedVersion: a.expected_version, idempotencyKey: a.idempotency_key, reason: a.reason,
    }, agent(a, c, true)));
  }),
  transfer_card_assignee: (o, a, c) => run(async () => {
    if (c.principal === "external") throw new Error("card mutation requires an agent session");
    if (!c.callerSessionId) throw new Error("authenticated request session header is required for card assignee handoff");
    matchingHeader(a, c);
    const actor = agent(a, c, true);
    if (actor.actorKind !== "agent" || actor.actorSessionId !== c.callerSessionId)
      throw new Error("card assignee handoff requires the authenticated agent session");
    return compactMutation(await mutation(o.cards, "update_card", String(a.card_id), {
      assignee: { kind: "session", sessionId: a.target_session_id },
      expectedVersion: a.expected_version, idempotencyKey: a.idempotency_key, reason: a.reason,
    }, actor));
  }),
  start_card_work: (o, a, c) => run(async () => {
    if (c.principal === "external") throw new Error("card mutation requires an agent session");
    matchingHeader(a, c);
    const actor = agent(a, c, true);
    if (!c.execution) throw new Error("Current work execution required; orchestration purpose cannot start work");
    return compactMutation(await mutation(o.cards, "start_card_work", String(a.card_id), {
      expectedVersion: a.expected_version, idempotencyKey: a.idempotency_key, reason: a.reason, execution: c.execution,
    }, actor));
  }),
  request_card_review: (o, a, c) => append(o.cards, "request_card_review", a, c, { ask:a.ask }),
  ask_card_question: (o, a, c) => append(o.cards, "ask_card_question", a, c, {
    text: a.text, ...(a.options !== undefined ? { options: a.options } : {}),
  }, false, result => ({ ...compactMutation(result), guidance: "질문이 등록되었다. 이 턴을 끝내고 답을 기다린다." })),
  move_card: (o, a, c) => append(o.cards, "move_card", a, c, {
    folderId: a.folder_id, ...(a.after_card_id !== undefined ? { afterCardId: a.after_card_id } : {}),
  }, true, result => ({ ...compactMutation(result), folderId: result.folderId })),
  set_card_items: (o,a,c) => internalAppend(o.cards,"set_card_items",a,c,{items:a.items},
    result => ({ ...compactMutation(result), items: compactItems(result) })),
  add_card_item: (o,a,c) => internalAppend(o.cards,"add_card_item",a,c,{title:a.title,fromCommentId:a.from_comment_id},
    result => ({ ...compactMutation(result), ...compactItemResult(result) })),
  report_card_item: (o,a,c) => internalAppend(o.cards,"report_card_item",a,c,{itemId:a.item_id,state:a.state,result:a.result,evidence:a.evidence,caveat:a.caveat,reopenReason:a.reopen_reason},
    result => ({ ...compactMutation(result), ...compactItemResult(result, a.item_id) })),
  update_card_now: (o,a,c) => internalAppend(o.cards,"update_card_now",a,c,{now:a.now,turn:a.turn,ask:a.ask}),
  add_card_note: (o,a,c) => internalAppend(o.cards,"add_card_note",a,c,{text:a.text},compactNote),
  list_card_notes: (o,a,c) => run(async () => {
    requireInternal(c);
    matchingHeader(a,c);
    const actor=agent(a,c,true);
    const cardId=String(a.card_id);
    await read(o.cards,cardId);
    const service=await o.cards.cardServiceProvider!();
    const page=await service.listCardNotes({cardId,...actor,limit:a.limit as number|undefined,before:a.before as string|undefined});
    return {notes:page.notes.map(serializeCardRow),nextCursor:page.nextCursor};
  }),
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
type MutationProjector = (result: Args) => Args;
async function append(options: Options, operation: CardOperation, args: Args, context: McpCallContext, body: Args,
  cas = false, project: MutationProjector = compactMutation) {
  return run(async () => project(await appendMutation(options, operation, args, agent(args, context), body, cas)));
}
async function internalAppend(options:Options,operation:CardOperation,args:Args,context:McpCallContext,body:Args,
  project: MutationProjector = compactMutation) {
  return run(async()=>{
    requireInternal(context);
    matchingHeader(args,context);
    return project(await appendMutation(options,operation,args,agent(args,context,true),body));
  });
}
function requireInternal(context:McpCallContext) {
  if(context.principal==="external") throw Object.assign(new Error("card mutation requires an agent session"),{statusCode:403});
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
async function runCard(options: Options, cardId: string, actor: FolderActorParams, signal?: AbortSignal) {
  const before = await read(options, cardId) as { card: { version: number } };
  let result = await request(async () => {
    if (!options.cardExecutionServiceProvider) throw Object.assign(new Error("Card execution unavailable"), { statusCode: 503 });
    const executor = await options.cardExecutionServiceProvider();
    return executor.execute({ ...actor, cardId, expectedVersion: before.card.version, idempotencyKey: randomUUID() });
  }) as { card: Record<string, unknown>; execution: { requestId: string; sessionId: string; state: string } };
  const intervalMs = options.runConfirm?.intervalMs ?? 1000;
  const deadline = Date.now() + (options.runConfirm?.timeoutMs ?? 30000);
  while (result.execution.state === "pending" && !signal?.aborted) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await wait(Math.min(intervalMs, remainingMs), signal);
    if (signal?.aborted || Date.now() >= deadline) break;
    result = await request(async () => {
      const executor = await options.cardExecutionServiceProvider!();
      return executor.observe(cardId, result.execution.requestId, actor);
    }) as typeof result;
  }
  return { card: serializeCardRow(result.card as never), execution: result.execution,
    ...(result.execution.state === "pending" ? { guidance: "실행 시작 확인이 아직이다. 잠시 뒤 같은 카드로 run_card를 다시 부르면 결과를 확인한다." } : {}) };
}
function compactCard(card: Args) {
  return { id: card.id, number: card.number, version: card.version, status: card.status };
}
function compactMutation(result: Args) {
  const card = result.card as Args | null;
  return {
    card: card ? compactCard(card) : { id: (result.operation as Args).targetId },
    ...(result.idempotent === true ? { idempotent: true } : {}),
  };
}
function compactExecution(result: Args, idempotent = false) {
  return {
    card: compactCard(result.card as Args),
    execution: result.execution,
    ...(idempotent ? { idempotent: true } : {}),
    ...(result.guidance !== undefined ? { guidance: result.guidance } : {}),
  };
}
function compactItem(item: Args) {
  return { id: item.id, title: item.title, state: item.state };
}
function compactItems(result: Args) {
  const card = result.card as Args | null;
  return Array.isArray(card?.items) ? (card.items as Args[]).map(compactItem) : [];
}
function compactItemResult(result: Args, itemId?: unknown) {
  const items = compactItems(result);
  const item = itemId === undefined
    ? items.reduce<Args | undefined>((latest, candidate) => !latest || Number(candidate.id) > Number(latest.id) ? candidate : latest, undefined)
    : items.find(candidate => candidate.id === itemId);
  return item ? { item } : {};
}
function compactNote(note: Args) {
  return { id: note.id, createdAt: note.createdAt };
}
function compactComment(comment: Args) {
  return {
    id: comment.id, kind: comment.kind, authorKind: comment.authorKind, createdAt: comment.createdAt,
    ...(comment.itemId != null ? { itemId: comment.itemId } : {}),
  };
}
function wait(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>(resolve => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
  });
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
