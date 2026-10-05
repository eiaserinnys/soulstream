import { CARD_STATUSES } from "@soulstream/wire-schema";
import { z } from "zod";
import { assigneeSchema, callerSessionIdSchema } from "./folder_shared.js";

const id = z.string().min(1);
const scope = { card_id: id, caller_session_id: callerSessionIdSchema };
const itemId = z.number().int().positive();
const itemEvidence = z.object({ type:z.enum(["image","link"]),url:id,label:z.string() }).strict();
export const cardTools = {
  create_card: { name: "create_card", timeoutMs: 60000, config: {
    description: "요청 원문이 고정된 카드를 드래프트로 만든다. queue=true면 대기열에 올려 순서가 오면 시스템이 실행한다. assignee와 node_id와 model_preset을 생략하면 만든 세션과 같은 값이 들어가며, brief에 인계 내용을 적는다.",
    inputSchema: { folder_id: id, title: id, request: z.string(), attachments: z.array(z.object({nodeId:id,path:id,name:id,mimeType:id}).strict()).optional(), assignee: assigneeSchema,
      brief: z.string().optional(), idempotency_key: id.optional(), node_id: id.optional(), model_preset: id.optional(), queue: z.boolean().optional(), caller_session_id: callerSessionIdSchema,
      run: z.boolean().optional().describe("true면 만든 직후 run_card와 같은 방식으로 바로 실행한다. queue와 함께 쓰지 않는다.") },
  }, audience: "all" },
  run_card: { name: "run_card", timeoutMs: 60000, config: {
    description: "드래프트(todo)나 대기(queued) 카드를 지금 실행한다. 시스템이 카드에 설정된 노드, 에이전트, 모델로 세션을 만들어 담당으로 잇고 진행 중으로 옮긴다. 담당 세션이 이미 있는 카드는 새로 만들지 않고 그 세션을 깨운다. 대기열 순서와 동시 실행 상한을 거치지 않는다. 생긴 세션은 부른 쪽의 자식이 아니며 완료 보고가 돌아오지 않으므로 경과는 카드에서 본다. 담당이 아니어도 실행할 수 있다.",
    inputSchema: scope,
  }, audience: "all" },
  list_cards: { name: "list_cards", config: {
    description: "폴더와 상태로 카드를 조회하고 folder_id가 없으면 모든 폴더를 조회한다.",
    inputSchema: { folder_id: id.optional(), status: z.enum(CARD_STATUSES).optional(), caller_session_id: callerSessionIdSchema },
  }, audience: "all" },
  get_card: { name: "get_card", config: {
    description: "카드의 요청, 확인 항목, 상황판, 커멘트, 보고, 질문과 세션을 읽습니다. 노트는 최근 20건이며 앞선 노트는 list_card_notes로 읽습니다.", inputSchema: scope,
  }, audience: "all" },
  update_card_brief: { name: "update_card_brief", config: {
    description: "다음 세션이 이어받을 담당 카드의 인계 요약을 고쳐 씁니다. 진행의 자세한 기록은 add_card_note에 씁니다.", inputSchema: { ...scope, brief: z.string() },
  }, audience: "all" },
  add_card_report: { name: "add_card_report", config: {
    description: "확인 항목이 없는 옛 카드에 보고를 추가합니다. 확인 항목이 있는 카드의 결과는 report_card_item에 답니다.",
    inputSchema: { ...scope, title: id, format: z.enum(["markdown", "html"]), body: z.string() },
  }, audience: "all" },
  add_card_comment: { name: "add_card_comment", config: {
    description: 'spoken은 사용자 발언 요약을 사용자 글로 기록하며 첫 줄은 "아래는 사용자의 발언을 요약하여 옮긴 것입니다"입니다. reply는 담당 세션이 사용자 글에 답하는 글입니다. 확인 항목이 있으면 mode가 필수이고 답은 300자까지 한 번만 받습니다. 진행은 add_card_note에 씁니다. item_id로 대상 항목을 표시할 수 있습니다.',
    inputSchema: { ...scope, text: id, mode: z.enum(["spoken", "reply"]).optional(), item_id:itemId.optional() },
  }, audience: "all" },
  set_card_status: { name: "set_card_status", config: {
    description: "담당 카드의 상태를 직접 변경한다. 보고·질문·사유·보관·이전 상태와 관계없이 완료·취소·재열기를 포함한 모든 상태를 선택할 수 있다. running 기록은 프로세스 실행 승인이 아니다.",
    inputSchema: {...scope,status:z.enum(CARD_STATUSES),expected_version:z.number().int().positive(),idempotency_key:id,reason:z.string().optional()},
  }, audience: "all" },
  transfer_card_assignee: { name: "transfer_card_assignee", config: {
    description: "공식 카드 PATCH와 같은 카드 변경 권한을 가진 인증된 내부 작업 세션이 호출하며, 현재 담당 여부와 무관하게 카드 담당을 지정 세션으로 명시적으로 변경한다. 호출자와 지정 담당 세션을 이력에 구분해 기록한다. 카드 상태나 실행 프로세스는 바꾸지 않으며, 지정 세션은 별도로 start_card_work를 호출해야 한다.",
    inputSchema: {...scope,target_session_id:id,expected_version:z.number().int().positive(),idempotency_key:id,reason:z.string().optional()},
  }, audience: "internal" },
  start_card_work: { name: "start_card_work", config: {
    description: "현재 담당 카드의 작업 착수를 명시합니다. 수동 착수는 모든 상태에서 가능하며 사유는 선택입니다. 실제 자동배정 실행일 때만 배정 승인과 해당 실행의 전달 소비를 확인합니다. 실행 신원은 런타임에서 제공합니다.",
    inputSchema: {...scope,expected_version:z.number().int().positive(),idempotency_key:id,reason:id.optional()},
  }, audience: "internal" },
  request_card_review: { name: "request_card_review", config: {
    description: "담당 카드의 검수를 요청합니다. 확인 항목이 있으면 ask에 사용자가 볼 것을 한 줄로 적으세요. 보고나 미답 질문은 상태 변경을 막지 않습니다.", inputSchema: { ...scope,ask:z.string().optional() },
  }, audience: "all" },
  ask_card_question: { name: "ask_card_question", config: {
    description: "AskUserQuestion 대신 카드에 질문을 남기고 이 턴을 끝내 답을 기다린다.",
    inputSchema: { ...scope, text: id, options: z.array(id).optional() },
  }, audience: "all" },
  move_card: { name: "move_card", config: {
    description: "카드를 다른 폴더로 옮기고 after_card_id 뒤에 놓는다.",
    inputSchema: { ...scope, folder_id: id, after_card_id: id.nullable().optional() },
  }, audience: "all" },
  set_card_items: { name: "set_card_items", config: {
    description: "담당 카드의 요청을 사용자가 확인할 결과 1~6개로 처음 나눕니다. 항목 하나는 화면이나 결과물을 보고 한 번에 됐다고 말할 결과입니다. 순서, PR, 검증 절차는 항목이 아닙니다. 제목은 40자까지입니다.",
    inputSchema: { ...scope,items:z.array(z.object({title:id}).strict()) },
  }, audience: "internal" },
  add_card_item: { name: "add_card_item", config: {
    description: "사용자가 새로 말한 결과를 담당 카드에 더합니다. from_comment_id에 이 카드의 사용자 커멘트나 발언 기록 ID를 넣으세요. 제목은 40자까지입니다. 확인하지 않은 항목이 여섯이면 사용자의 확인을 기다립니다.",
    inputSchema: { ...scope,title:id,from_comment_id:id },
  }, audience: "internal" },
  report_card_item: { name: "report_card_item", config: {
    description: "담당 항목을 doing, done, dropped로 알립니다. 끝나거나 빼면 result에 결과나 까닭 한 줄(80자까지)을 쓰고 evidence에 캡처와 링크를 넷까지 답니다(설명 40자까지). 못 본 것은 caveat(60자까지)에 적습니다. 사용자가 확인한 항목을 고칠 때는 reopen_reason(80자까지)이 필요합니다. 커밋, 경로, URL 같은 식별자는 노트에 적습니다.",
    inputSchema: { ...scope,item_id:itemId,state:z.enum(["doing","done","dropped"]),result:z.string().optional(),evidence:z.array(itemEvidence).optional(),caveat:z.string().optional(),reopen_reason:z.string().optional() },
  }, audience: "internal" },
  update_card_now: { name: "update_card_now", config: {
    description: "담당 카드의 지금 한 줄과 누구 차례인지를 고쳐 씁니다. now와 ask는 각각 60자까지이며 식별자를 넣지 않습니다. turn=user면 ask에 사용자가 볼 것을 적으세요. 턴을 끝내기 전에 현재와 맞춥니다.",
    inputSchema: { ...scope,now:z.string(),turn:z.enum(["agent","user","outside"]),ask:z.string().optional() },
  }, audience: "internal" },
  add_card_note: { name: "add_card_note", config: {
    description: "담당 카드의 진행과 기술 세부를 노트에 기록합니다(4,000자까지). 식별자와 자세한 로그는 여기에 쓰세요. 사용자에게 답하는 글과 항목의 결과는 각 도구에 씁니다.",
    inputSchema: { ...scope,text:z.string() },
  }, audience: "internal" },
  list_card_notes: { name: "list_card_notes", config: {
    description: "담당 카드의 작업 노트를 최신순으로 읽습니다. 다음 목록은 before에 직전 목록의 nextCursor를 넣어 읽으세요.",
    inputSchema: { ...scope,limit:z.number().int().optional(),before:id.optional() },
  }, audience: "internal" },
} as const;
