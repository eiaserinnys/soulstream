import { z } from "zod";
import { CARD_STATUSES } from "@soulstream/wire-schema";
import { CARD_COLOR_KEYS } from "@soulstream/wire-schema/card-colors";
import { cardEvidenceSchema, cardQuestionAttachmentsSchema, cardQuestionInputIssues, cardQuestionKindSchema, cardQuestionOptionsInputSchema, cardQuestionTitleSchema, cardVerificationWakeAtSchema, cardVerificationWaitingForSchema } from "@soulstream/mcp-contract";
import type { CardControlPlaneService } from "./card_control_plane_service.js";
import type { FolderActorParams } from "./control_plane/card_types.js";
import { serializeCardMutation, serializeCardRow } from "../folders/folder_contracts.js";
const id=z.string().min(1);
const attachments=z.array(z.object({nodeId:id,path:id,name:id,mimeType:id}).strict()).default([]);
const assignee=z.object({ kind:z.enum(["agent","human","session"]).nullable(),agentId:id.nullable().optional(),sessionId:id.nullable().optional(),userId:id.nullable().optional() });
const mutation=z.object({ expectedVersion:z.number().int().positive(),idempotencyKey:id,reason:z.string().nullable().optional() });
const append=z.object({ idempotencyKey:id });
const itemId=z.number().int().positive();
const evidence=z.array(cardEvidenceSchema);
export const cardOperationSchemas={
  create_card:z.object({ folderId:id,title:id,request:z.string(),brief:z.string().optional(),attachments,queue:z.boolean().optional(),assignee:assignee.nullable().optional(),nodeId:id.nullable().optional(),modelPreset:id.nullable().optional(),idempotencyKey:id }),
  update_card:mutation.extend({ title:id.optional(),brief:z.string().optional(),archived:z.boolean().optional(),assignee:assignee.nullable().optional(),nodeId:id.nullable().optional(),modelPreset:id.nullable().optional(),color:z.enum(CARD_COLOR_KEYS).optional() }).refine(v=>Object.keys(v).some(k=>!["expectedVersion","idempotencyKey","reason"].includes(k)),"Patch requires a field"),
  start_card_work:mutation.extend({execution:z.object({registrationId:id,executionCommandId:id}).strict()}),
  set_card_status:mutation.extend({ status:z.enum(CARD_STATUSES),blockedKind:z.enum(["limit","question","no_report"]).nullable().optional(),blockedDetail:z.string().nullable().optional(),
    wakeAt:cardVerificationWakeAtSchema.optional(),waitingFor:cardVerificationWaitingForSchema.optional() })
    .superRefine((value,ctx)=>{
      if (value.status === "awaiting_verification") {
        if (value.wakeAt === undefined) ctx.addIssue({ code:"custom",path:["wakeAt"],message:"검증 대기에는 wakeAt이 필요합니다" });
        if (value.waitingFor === undefined) ctx.addIssue({ code:"custom",path:["waitingFor"],message:"검증 대기에는 waitingFor가 필요합니다" });
        return;
      }
      if (value.wakeAt !== undefined) ctx.addIssue({ code:"custom",path:["wakeAt"],message:"검증 대기가 아니면 wakeAt을 주지 않습니다" });
      if (value.waitingFor !== undefined) ctx.addIssue({ code:"custom",path:["waitingFor"],message:"검증 대기가 아니면 waitingFor를 주지 않습니다" });
  }),
  move_card:mutation.extend({ folderId:id,afterCardId:id.nullable().optional() }),
  reorder_card_queue:mutation.extend({ afterCardId:id.nullable().optional() }),
  add_card_report:append.extend({ title:id,format:z.enum(["markdown","html"]),body:z.string() }),
  update_card_brief:mutation.extend({ brief:z.string() }),
  add_card_comment:append.extend({ body:z.string(),kind:z.enum(["comment","spoken"]).optional(),mode:z.enum(["spoken","reply"]).optional(),itemId:itemId.optional() }),
  ask_card_question:append.extend({ text:id,title:cardQuestionTitleSchema.optional(),kind:cardQuestionKindSchema.optional(),
    options:cardQuestionOptionsInputSchema.optional(),attachments:cardQuestionAttachmentsSchema.optional(),questionId:id.optional() })
    .strict().superRefine((value,ctx)=>{ for (const issue of cardQuestionInputIssues(value)) ctx.addIssue({code:"custom",path:issue.path,message:issue.message}); }),
  withdraw_card_question:append.extend({ questionId:id,reason:id }),
  answer_card_question:append.extend({ questionId:id,answer:id }),
  set_card_items:append.extend({ items:z.array(z.object({title:id}).strict()) }),
  add_card_item:append.extend({ title:id,fromCommentId:id }),
  report_card_item:append.extend({ itemId,state:z.enum(["doing","done","dropped"]),result:z.string().optional(),evidence:evidence.optional(),caveat:z.string().optional(),reopenReason:z.string().optional() }),
  confirm_card_item:append.extend({ itemId,confirmed:z.boolean() }),
  update_card_now:append.extend({ now:z.string(),turn:z.enum(["agent","user","outside"]),ask:z.string().optional() }),
  add_card_note:append.extend({ text:z.string() }),
  request_card_review:append.extend({ ask:z.string().optional() }),
} as const;
export type CardOperation=keyof typeof cardOperationSchemas;
/** 상태 변경·검증 대기를 잘못된 진입점으로 보낸 요청은 계약상 400이다. 기존 엄격 schema 위반의 422는 그대로 둔다. */
function assertVerificationWaitBoundary(operation:CardOperation,input:unknown) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return;
  const body=input as Record<string,unknown>;
  const has=(key:string)=>Object.prototype.hasOwnProperty.call(body,key);
  if (operation === "update_card" && ["status","wakeAt","waitingFor","wake_at","waiting_for"].some(has))
    throw boundaryError("상태 변경과 검증 대기는 POST /api/cards/:id/status로 보냅니다");
  if (operation !== "set_card_status") return;
  const hasWake=has("wakeAt"),hasWaiting=has("waitingFor");
  if (body.status === "awaiting_verification" && (!hasWake || !hasWaiting))
    throw boundaryError("검증 대기에는 wakeAt과 waitingFor가 필요합니다");
  if (body.status !== "awaiting_verification" && (hasWake || hasWaiting))
    throw boundaryError("검증 대기가 아니면 wakeAt과 waitingFor를 주지 않습니다");
}
function boundaryError(message:string) { return Object.assign(new Error(message),{ statusCode:400,code:"INVALID_CARD_REQUEST" }); }
export async function executeCardOperation(service:CardControlPlaneService,operation:CardOperation,body:unknown,cardId:string | undefined,actor:FolderActorParams) {
  assertVerificationWaitBoundary(operation,body);
  const parsed=cardOperationSchemas[operation].strict().parse(body);
  if (operation === "add_card_comment") {
    const common={ ...actor,cardId:id.parse(cardId) };
    const comment=await service.addComment({ ...common,...cardOperationSchemas.add_card_comment.parse(parsed) });
    return serializeCardRow(comment);
  }
  if (operation === "add_card_note") {
    const common={ ...actor,cardId:id.parse(cardId) };
    const note=await service.addCardNote({ ...common,...cardOperationSchemas.add_card_note.parse(parsed) });
    return serializeCardRow(note);
  }
  const result=await (async () => {
    if (operation === "create_card") return service.createCard({ ...actor,...cardOperationSchemas.create_card.parse(parsed) });
    const common={ ...actor,cardId:id.parse(cardId) };
    switch(operation) {
      case "update_card":return service.patchCard({ ...common,...cardOperationSchemas.update_card.parse(parsed) });
      case "start_card_work":return service.startCardWork({ ...common,...cardOperationSchemas.start_card_work.parse(parsed) });
      case "set_card_status":return service.setCardStatus({ ...common,...cardOperationSchemas.set_card_status.parse(parsed) });
      case "move_card":return service.moveCard({ ...common,...cardOperationSchemas.move_card.parse(parsed) });
      case "reorder_card_queue":return service.reorderQueue({ ...common,...cardOperationSchemas.reorder_card_queue.parse(parsed) });
      case "add_card_report":return service.addReport({ ...common,...cardOperationSchemas.add_card_report.parse(parsed) });
      case "update_card_brief":return service.updateCardBrief({ ...common,...cardOperationSchemas.update_card_brief.parse(parsed) });
      case "ask_card_question":return service.askQuestion({ ...common,...cardOperationSchemas.ask_card_question.parse(parsed) });
      case "withdraw_card_question":return service.withdrawQuestion({ ...common,...cardOperationSchemas.withdraw_card_question.parse(parsed) });
      case "answer_card_question":return service.answerQuestion({ ...common,...cardOperationSchemas.answer_card_question.parse(parsed) });
      case "set_card_items": {
        const input=cardOperationSchemas.set_card_items.parse(parsed);
        return service.setCardItems({ ...common,...input,items:input.items.map(item=>item.title) });
      }
      case "add_card_item":return service.addCardItem({ ...common,...cardOperationSchemas.add_card_item.parse(parsed) });
      case "report_card_item":return service.reportCardItem({ ...common,...cardOperationSchemas.report_card_item.parse(parsed) });
      case "confirm_card_item":return service.confirmCardItem({ ...common,...cardOperationSchemas.confirm_card_item.parse(parsed) });
      case "update_card_now":return service.updateCardNow({ ...common,...cardOperationSchemas.update_card_now.parse(parsed) });
      case "request_card_review":return service.requestCardReview({ ...common,...cardOperationSchemas.request_card_review.parse(parsed) });
    }
  })();
  return serializeCardMutation(result);
}
export type CardDetail = NonNullable<Awaited<ReturnType<CardControlPlaneService["getCard"]>>>;
export class CardOperationError extends Error {
  readonly code = "INVALID_CARD_REQUEST";
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "CardOperationError";
  }
}
export function serializeCardDetail(detail:CardDetail) {
  return { card:serializeCardRow(detail.card),reports:detail.reports.map(serializeCardRow),questions:detail.questions.map(serializeCardRow),
    comments:detail.comments.map(serializeCardRow),sessions:detail.sessions.map(serializeCardRow),notes:detail.notes.map(serializeCardRow),nowHistory:detail.nowHistory };
}
