import { z } from "zod";
import { CARD_STATUSES } from "@soulstream/wire-schema";
import { CARD_COLOR_KEYS } from "@soulstream/wire-schema/card-colors";
import type { CardControlPlaneService } from "./card_control_plane_service.js";
import type { FolderActorParams } from "./control_plane/card_types.js";
import { serializeCardMutation, serializeCardRow } from "../folders/folder_contracts.js";
const id=z.string().min(1);
const attachments=z.array(z.object({nodeId:id,path:id,name:id,mimeType:id}).strict()).default([]);
const assignee=z.object({ kind:z.enum(["agent","human","session"]).nullable(),agentId:id.nullable().optional(),sessionId:id.nullable().optional(),userId:id.nullable().optional() });
const mutation=z.object({ expectedVersion:z.number().int().positive(),idempotencyKey:id,reason:z.string().nullable().optional() });
const append=z.object({ idempotencyKey:id });
const itemId=z.number().int().positive();
const evidence=z.array(z.object({type:z.enum(["image","link"]),url:id,label:z.string()}).strict());
export const cardOperationSchemas={
  create_card:z.object({ folderId:id,title:id,request:z.string(),brief:z.string().optional(),attachments,queue:z.boolean().optional(),assignee:assignee.nullable().optional(),nodeId:id.nullable().optional(),modelPreset:id.nullable().optional(),idempotencyKey:id }),
  update_card:mutation.extend({ title:id.optional(),brief:z.string().optional(),archived:z.boolean().optional(),assignee:assignee.nullable().optional(),nodeId:id.nullable().optional(),modelPreset:id.nullable().optional(),color:z.enum(CARD_COLOR_KEYS).optional() }).refine(v=>Object.keys(v).some(k=>!["expectedVersion","idempotencyKey","reason"].includes(k)),"Patch requires a field"),
  start_card_work:mutation.extend({execution:z.object({registrationId:id,executionCommandId:id}).strict()}),
  set_card_status:mutation.extend({ status:z.enum(CARD_STATUSES),blockedKind:z.enum(["limit","question","no_report"]).nullable().optional(),blockedDetail:z.string().nullable().optional() }),
  move_card:mutation.extend({ folderId:id,afterCardId:id.nullable().optional() }),
  reorder_card_queue:mutation.extend({ afterCardId:id.nullable().optional() }),
  add_card_report:append.extend({ title:id,format:z.enum(["markdown","html"]),body:z.string() }),
  add_card_comment:append.extend({ body:z.string(),kind:z.enum(["comment","spoken"]).optional(),mode:z.enum(["spoken","reply"]).optional(),itemId:itemId.optional() }),
  ask_card_question:append.extend({ text:id,options:z.array(id).nullable().optional() }),
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
export async function executeCardOperation(service:CardControlPlaneService,operation:CardOperation,body:unknown,cardId:string | undefined,actor:FolderActorParams) {
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
      case "ask_card_question":return service.askQuestion({ ...common,...cardOperationSchemas.ask_card_question.parse(parsed) });
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
export function serializeCardDetail(detail:NonNullable<Awaited<ReturnType<CardControlPlaneService["getCard"]>>>) {
  return { card:serializeCardRow(detail.card),reports:detail.reports.map(serializeCardRow),questions:detail.questions.map(serializeCardRow),
    comments:detail.comments.map(serializeCardRow),sessions:detail.sessions.map(serializeCardRow),notes:detail.notes.map(serializeCardRow),nowHistory:detail.nowHistory };
}
