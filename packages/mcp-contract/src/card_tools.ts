import { CARD_STATUSES } from "@soulstream/wire-schema";
import { z } from "zod";
import { assigneeSchema, callerSessionIdSchema } from "./folder_shared.js";

const id = z.string().min(1);
const scope = { card_id: id, caller_session_id: callerSessionIdSchema };

export const cardTools = {
  create_card: { name: "create_card", config: {
    description: "요청 원문이 고정된 카드를 만들고 queue=true면 대기열에 넣는다.",
    inputSchema: { folder_id: id, title: id, request: z.string(), attachments: z.array(z.object({nodeId:id,path:id,name:id,mimeType:id}).strict()).optional(), assignee: assigneeSchema,
      node_id: id.optional(), model_preset: id.optional(), queue: z.boolean().optional(), caller_session_id: callerSessionIdSchema },
  }, audience: "all" },
  list_cards: { name: "list_cards", config: {
    description: "폴더와 상태로 카드를 조회하고 folder_id가 없으면 모든 폴더를 조회한다.",
    inputSchema: { folder_id: id.optional(), status: z.enum(CARD_STATUSES).optional(), caller_session_id: callerSessionIdSchema },
  }, audience: "all" },
  get_card: { name: "get_card", config: {
    description: "카드 본문과 보고, 질문, 커멘트, 연결된 세션 목록을 조회한다.", inputSchema: scope,
  }, audience: "all" },
  update_card_brief: { name: "update_card_brief", config: {
    description: "카드의 해석된 요구사항과 진행 경과를 갱신한다.", inputSchema: { ...scope, brief: z.string() },
  }, audience: "all" },
  add_card_report: { name: "add_card_report", config: {
    description: "카드에 보고를 추가하며 보고를 고칠 때는 새 보고를 올린다.",
    inputSchema: { ...scope, title: id, format: z.enum(["markdown", "html"]), body: z.string() },
  }, audience: "all" },
  add_card_comment: { name: "add_card_comment", config: {
    description: '담당 세션이 카드에 커멘트를 남긴다. mode=spoken(기본)은 사용자 발언 요약만 사용자가 말한 것처럼 기록하며 첫 줄에 정확히 "아래는 사용자의 발언을 요약하여 옮긴 것입니다"라고 표기한다. mode=reply는 담당 세션 자신의 답변만 에이전트 신원으로 기록한다. 두 내용을 엄밀하게 구분한다. 본문은 자동 변경하지 않으며 카드 상태도 바꾸지 않는다.',
    inputSchema: { ...scope, text: id, mode: z.enum(["spoken", "reply"]).optional() },
  }, audience: "all" },
  set_card_status: { name: "set_card_status", config: {
    description: "담당 카드의 상태를 직접 변경한다. 보고·질문·사유·보관·이전 상태와 관계없이 완료·취소·재열기를 포함한 모든 상태를 선택할 수 있다. running 기록은 프로세스 실행 승인이 아니다.",
    inputSchema: {...scope,status:z.enum(CARD_STATUSES),expected_version:z.number().int().positive(),idempotency_key:id,reason:z.string().optional()},
  }, audience: "all" },
  start_card_work: { name: "start_card_work", config: {
    description: "현재 담당 카드의 작업 착수를 명시합니다. 수동 착수는 모든 상태에서 가능하며 사유는 선택입니다. 실제 자동배정 실행일 때만 배정 승인과 해당 실행의 전달 소비를 확인합니다. 실행 신원은 런타임에서 제공합니다.",
    inputSchema: {...scope,expected_version:z.number().int().positive(),idempotency_key:id,reason:id.optional()},
  }, audience: "internal" },
  request_card_review: { name: "request_card_review", config: {
    description: "카드 상태를 검수 대기로 변경한다. 보고와 미답 질문은 상태 변경을 막지 않는다.", inputSchema: scope,
  }, audience: "all" },
  ask_card_question: { name: "ask_card_question", config: {
    description: "AskUserQuestion 대신 카드에 질문을 남기고 이 턴을 끝내 답을 기다린다.",
    inputSchema: { ...scope, text: id, options: z.array(id).optional() },
  }, audience: "all" },
  move_card: { name: "move_card", config: {
    description: "카드를 다른 폴더로 옮기고 after_card_id 뒤에 놓는다.",
    inputSchema: { ...scope, folder_id: id, after_card_id: id.nullable().optional() },
  }, audience: "all" },
} as const;
