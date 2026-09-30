import { z } from "zod";
import { CARD_STATUSES } from "@soulstream/wire-schema";
import type { CardControlPlaneService } from "./card_control_plane_service.js";
import type { FolderActorParams } from "./control_plane/card_types.js";
import { serializeCardMutation, serializeCardRow } from "../folders/folder_contracts.js";
const id=z.string().min(1);
const assignee=z.object({ kind:z.enum(["agent","human","session"]).nullable(),agentId:id.nullable().optional(),sessionId:id.nullable().optional(),userId:id.nullable().optional() });
const mutation=z.object({ expectedVersion:z.number().int().positive(),idempotencyKey:id,reason:z.string().nullable().optional() });
const append=z.object({ idempotencyKey:id });
export const cardOperationSchemas={
  create_card:z.object({ folderId:id,title:id,request:z.string(),queue:z.boolean().optional(),assignee:assignee.nullable().optional(),nodeId:id.nullable().optional(),modelPreset:id.nullable().optional(),idempotencyKey:id }),
  update_card:mutation.extend({ title:id.optional(),brief:z.string().optional(),archived:z.boolean().optional(),assignee:assignee.nullable().optional(),nodeId:id.nullable().optional(),modelPreset:id.nullable().optional() }).refine(v=>Object.keys(v).some(k=>!["expectedVersion","idempotencyKey","reason"].includes(k)),"Patch requires a field"),
  set_card_status:mutation.extend({ status:z.enum(CARD_STATUSES),blockedKind:z.enum(["limit","question","no_report"]).nullable().optional(),blockedDetail:z.string().nullable().optional() }),
  move_card:mutation.extend({ folderId:id,afterCardId:id.nullable().optional() }),
  reorder_card_queue:mutation.extend({ afterCardId:id.nullable().optional() }),
  add_card_report:append.extend({ title:id,format:z.enum(["markdown","html"]),body:z.string() }),
  add_card_comment:append.extend({ body:z.string(),kind:z.enum(["comment","spoken"]).optional() }),
  ask_card_question:append.extend({ text:id,options:z.array(id).nullable().optional() }),
  answer_card_question:append.extend({ questionId:id,answer:id }),
} as const;
export type CardOperation=keyof typeof cardOperationSchemas;
export async function executeCardOperation(service:CardControlPlaneService,operation:CardOperation,body:unknown,cardId:string | undefined,actor:FolderActorParams) {
  const parsed=cardOperationSchemas[operation].strict().parse(body);
  if (operation === "add_card_comment") {
    const common={ ...actor,cardId:id.parse(cardId) };
    const comment=await service.addComment({ ...common,...cardOperationSchemas.add_card_comment.parse(parsed) });
    return serializeCardRow(comment);
  }
  const result=await (async () => {
    if (operation === "create_card") return service.createCard({ ...actor,...cardOperationSchemas.create_card.parse(parsed) });
    const common={ ...actor,cardId:id.parse(cardId) };
    switch(operation) {
      case "update_card":return service.patchCard({ ...common,...cardOperationSchemas.update_card.parse(parsed) });
      case "set_card_status":return service.setCardStatus({ ...common,...cardOperationSchemas.set_card_status.parse(parsed) });
      case "move_card":return service.moveCard({ ...common,...cardOperationSchemas.move_card.parse(parsed) });
      case "reorder_card_queue":return service.reorderQueue({ ...common,...cardOperationSchemas.reorder_card_queue.parse(parsed) });
      case "add_card_report":return service.addReport({ ...common,...cardOperationSchemas.add_card_report.parse(parsed) });
      case "ask_card_question":return service.askQuestion({ ...common,...cardOperationSchemas.ask_card_question.parse(parsed) });
      case "answer_card_question":return service.answerQuestion({ ...common,...cardOperationSchemas.answer_card_question.parse(parsed) });
    }
  })();
  return serializeCardMutation(result);
}
export function serializeCardDetail(detail:NonNullable<Awaited<ReturnType<CardControlPlaneService["getCard"]>>>) {
  return { card:serializeCardRow(detail.card),reports:detail.reports.map(serializeCardRow),questions:detail.questions.map(serializeCardRow),comments:detail.comments.map(serializeCardRow),sessions:detail.sessions.map(serializeCardRow) };
}
