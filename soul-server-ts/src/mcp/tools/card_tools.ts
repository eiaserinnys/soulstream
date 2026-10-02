import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CARD_STATUSES } from "@soulstream/wire-schema";
import { z } from "zod";
import type { McpRuntime } from "../runtime.js";
import { errorResultFromError, jsonResult } from "../result.js";
import { requireMcpMutationActor, resolveEffectiveCallerSessionId } from "./caller_session.js";
import { assigneePatch, assigneeSchema, callerSessionIdSchema, getFolderService } from "./folder_tool_shared.js";

import { getCurrentMcpCallerSessionId } from "../request_context.js";

const id = z.string().min(1);
const scope = { card_id: id, caller_session_id: callerSessionIdSchema };

export function registerCardTools(server: McpServer, runtime: McpRuntime): void {
  server.registerTool("create_card", {
    description: "요청 원문이 고정된 카드를 만들고 queue=true면 대기열에 넣는다.",
    inputSchema: { folder_id: id, title: id, request: z.string(), attachments: z.array(z.object({nodeId:id,path:id,name:id,mimeType:id}).strict()).optional(), assignee: assigneeSchema,
      node_id: id.optional(), model_preset: id.optional(), queue: z.boolean().optional(), caller_session_id: callerSessionIdSchema },
  }, async input => run(async () => getFolderService(runtime).createCard({
    ...agent(input.caller_session_id), folderId: input.folder_id, title: input.title, request: input.request, attachments: input.attachments,
    ...assigneePatch(input), nodeId: input.node_id, modelPreset: input.model_preset, queue: input.queue,
  })));
  server.registerTool("list_cards", {
    description: "폴더와 상태로 카드를 조회하고 folder_id가 없으면 모든 폴더를 조회한다.",
    inputSchema: { folder_id: id.optional(), status: z.enum(CARD_STATUSES).optional(), caller_session_id: callerSessionIdSchema },
  }, async input => run(() => getFolderService(runtime).listCards({ folderId: input.folder_id, status: input.status,
    actorSessionId: resolveEffectiveCallerSessionId(input.caller_session_id) })));
  server.registerTool("get_card", {
    description: "카드 본문과 보고, 질문, 커멘트, 연결된 세션 목록을 조회한다.", inputSchema: scope,
  }, async input => run(() => getFolderService(runtime).getCard(input.card_id, resolveEffectiveCallerSessionId(input.caller_session_id))));
  server.registerTool("update_card_brief", {
    description: "카드의 해석된 요구사항과 진행 경과를 갱신한다.", inputSchema: { ...scope, brief: z.string() },
  }, async input => run(() => getFolderService(runtime).updateCardBrief({ ...agent(input.caller_session_id), cardId: input.card_id, brief: input.brief })));
  server.registerTool("add_card_report", {
    description: "카드에 보고를 추가하며 보고를 고칠 때는 새 보고를 올린다.",
    inputSchema: { ...scope, title: id, format: z.enum(["markdown", "html"]), body: z.string() },
  }, async input => run(() => getFolderService(runtime).addCardReport({ ...agent(input.caller_session_id), cardId: input.card_id, title: input.title, format: input.format, body: input.body })));
  server.registerTool("add_card_comment", {
    description: '담당 세션이 카드에 커멘트를 남긴다. mode=spoken(기본)은 사용자 발언 요약만 사용자가 말한 것처럼 기록하며 첫 줄에 정확히 "아래는 사용자의 발언을 요약하여 옮긴 것입니다"라고 표기한다. mode=reply는 담당 세션 자신의 답변만 에이전트 신원으로 기록한다. 두 내용을 엄밀하게 구분한다. 본문은 자동 변경하지 않으며 카드 상태도 바꾸지 않는다.',
    inputSchema: { ...scope, text: id, mode: z.enum(["spoken", "reply"]).optional() },
  }, async input => run(() => {
    const header = getCurrentMcpCallerSessionId();
    if (input.mode === "reply" && header && input.caller_session_id && input.caller_session_id.trim() !== header)
      throw new Error("caller_session_id must match the authenticated request session header");
    return getFolderService(runtime).addCardComment({ ...agent(input.caller_session_id), cardId: input.card_id, text: input.text, mode: input.mode });
  }));
  server.registerTool("start_card_work", {
    description: "현재 담당 카드의 작업 착수를 명시합니다. todo/review/blocked(question)는 담당 선언, queued는 유효 자동배정 승인과 해당 실행의 전달 소비가 필요합니다. 검수 재착수에는 reason을 씁니다. 미답 질문은 착수를 막지 않습니다.",
    inputSchema: {...scope,expected_version:z.number().int().positive(),idempotency_key:id,reason:id.optional()},
  }, async input => run(async () => {
    const header = getCurrentMcpCallerSessionId();
    if (header && input.caller_session_id && input.caller_session_id.trim() !== header) throw new Error("caller_session_id must match the authenticated request session header");
    const actor = agent(header ?? input.caller_session_id);
    const task = runtime.taskManager.getTask(actor.actorSessionId);
    if (!task?.executionRegistration || task.orchestrationPurpose) throw new Error("Current work execution required; orchestration purpose cannot start work");
    return getFolderService(runtime).startCardWork({...actor,cardId:input.card_id,expectedVersion:input.expected_version,
      idempotencyKey:input.idempotency_key,reason:input.reason,execution:{...task.executionRegistration}});
  }));
  server.registerTool("request_card_review", {
    description: "카드 검수를 요청하며 보고가 없으면 서버가 거부한다.", inputSchema: scope,
  }, async input => run(() => getFolderService(runtime).requestCardReview({ ...agent(input.caller_session_id), cardId: input.card_id })));
  server.registerTool("ask_card_question", {
    description: "AskUserQuestion 대신 카드에 질문을 남기고 이 턴을 끝내 답을 기다린다.",
    inputSchema: { ...scope, text: id, options: z.array(id).optional() },
  }, async input => run(async () => {
    const result = await getFolderService(runtime).askCardQuestion({ ...agent(input.caller_session_id), cardId: input.card_id, text: input.text, options: input.options });
    return { ...result, guidance: "질문이 등록되었다. 이 턴을 끝내고 답을 기다린다." };
  }));
  server.registerTool("move_card", {
    description: "카드를 다른 폴더로 옮기고 after_card_id 뒤에 놓는다.",
    inputSchema: { ...scope, folder_id: id, after_card_id: id.nullable().optional() },
  }, async input => run(() => getFolderService(runtime).moveCard({ ...agent(input.caller_session_id), cardId: input.card_id, folderId: input.folder_id, afterCardId: input.after_card_id })));
}

function agent(callerSessionId?: string) {
  const actor = requireMcpMutationActor(callerSessionId, "card mutation");
  if (actor.actorKind !== "agent") throw new Error("card mutation requires an agent session");
  return actor;
}
async function run(fn: () => Promise<unknown>) {
  try { return jsonResult(await fn()); }
  catch (error) { return errorResultFromError(error); }
}
