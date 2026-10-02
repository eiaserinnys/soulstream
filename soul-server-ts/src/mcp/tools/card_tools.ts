import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { cardTools } from "@soulstream/mcp-contract";
import { registerOrchestratorTools } from "../orchestrator_tools.js";
import type { McpRuntime } from "../runtime.js";
import { errorResultFromError, jsonResult } from "../result.js";
import { requireMcpMutationActor, resolveEffectiveCallerSessionId } from "./caller_session.js";
import { assigneePatch, getFolderService } from "./folder_tool_shared.js";

import { getCurrentMcpCallerSessionId } from "../request_context.js";


export function registerCardTools(server: McpServer, runtime: McpRuntime): void {
  registerOrchestratorTools(server, runtime, Object.values(cardTools), {
    start_card_work: input => {
      const header = getCurrentMcpCallerSessionId();
      if (header && input.caller_session_id && String(input.caller_session_id).trim() !== header)
        throw new Error("caller_session_id must match the authenticated request session header");
      const actor = agent(header ?? input.caller_session_id as string | undefined);
      const task = runtime.taskManager.getTask(actor.actorSessionId);
      if (!task?.executionRegistration || task.orchestrationPurpose)
        throw new Error("Current work execution required; orchestration purpose cannot start work");
      return { execution: { ...task.executionRegistration } };
    },
  });
}

/** Kept only as the pre-migration oracle for roundtrip tests. */
export function registerCardToolsLegacy(server: McpServer, runtime: McpRuntime): void {
  server.registerTool("create_card", cardTools.create_card.config, async input => run(async () => getFolderService(runtime).createCard({
    ...agent(input.caller_session_id), folderId: input.folder_id, title: input.title, request: input.request, attachments: input.attachments,
    ...assigneePatch(input), nodeId: input.node_id, modelPreset: input.model_preset, queue: input.queue,
  })));
  server.registerTool("list_cards", cardTools.list_cards.config, async input => run(() => getFolderService(runtime).listCards({ folderId: input.folder_id, status: input.status,
    actorSessionId: resolveEffectiveCallerSessionId(input.caller_session_id) })));
  server.registerTool("get_card", cardTools.get_card.config, async input => run(() => getFolderService(runtime).getCard(input.card_id, resolveEffectiveCallerSessionId(input.caller_session_id))));
  server.registerTool("update_card_brief", cardTools.update_card_brief.config, async input => run(() => getFolderService(runtime).updateCardBrief({ ...agent(input.caller_session_id), cardId: input.card_id, brief: input.brief })));
  server.registerTool("add_card_report", cardTools.add_card_report.config, async input => run(() => getFolderService(runtime).addCardReport({ ...agent(input.caller_session_id), cardId: input.card_id, title: input.title, format: input.format, body: input.body })));
  server.registerTool("add_card_comment", cardTools.add_card_comment.config, async input => run(() => {
    const header = getCurrentMcpCallerSessionId();
    if (input.mode === "reply" && header && input.caller_session_id && input.caller_session_id.trim() !== header)
      throw new Error("caller_session_id must match the authenticated request session header");
    return getFolderService(runtime).addCardComment({ ...agent(input.caller_session_id), cardId: input.card_id, text: input.text, mode: input.mode });
  }));
  server.registerTool("set_card_status", cardTools.set_card_status.config, async input => run(() => {
    const header = getCurrentMcpCallerSessionId();
    if (header && input.caller_session_id && input.caller_session_id.trim() !== header)
      throw new Error("caller_session_id must match the authenticated request session header");
    return getFolderService(runtime).setCardStatus({...agent(header ?? input.caller_session_id),cardId:input.card_id,status:input.status,
      expectedVersion:input.expected_version,idempotencyKey:input.idempotency_key,reason:input.reason});
  }));
  server.registerTool("start_card_work", cardTools.start_card_work.config, async input => run(async () => {
    const header = getCurrentMcpCallerSessionId();
    if (header && input.caller_session_id && input.caller_session_id.trim() !== header) throw new Error("caller_session_id must match the authenticated request session header");
    const actor = agent(header ?? input.caller_session_id);
    const task = runtime.taskManager.getTask(actor.actorSessionId);
    if (!task?.executionRegistration || task.orchestrationPurpose) throw new Error("Current work execution required; orchestration purpose cannot start work");
    return getFolderService(runtime).startCardWork({...actor,cardId:input.card_id,expectedVersion:input.expected_version,
      idempotencyKey:input.idempotency_key,reason:input.reason,execution:{...task.executionRegistration}});
  }));
  server.registerTool("request_card_review", cardTools.request_card_review.config, async input => run(() => getFolderService(runtime).requestCardReview({ ...agent(input.caller_session_id), cardId: input.card_id })));
  server.registerTool("ask_card_question", cardTools.ask_card_question.config, async input => run(async () => {
    const result = await getFolderService(runtime).askCardQuestion({ ...agent(input.caller_session_id), cardId: input.card_id, text: input.text, options: input.options });
    return { ...result, guidance: "질문이 등록되었다. 이 턴을 끝내고 답을 기다린다." };
  }));
  server.registerTool("move_card", cardTools.move_card.config, async input => run(() => getFolderService(runtime).moveCard({ ...agent(input.caller_session_id), cardId: input.card_id, folderId: input.folder_id, afterCardId: input.after_card_id })));
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
