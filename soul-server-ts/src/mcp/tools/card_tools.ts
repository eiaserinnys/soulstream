import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { cardTools } from "@soulstream/mcp-contract";
import { registerOrchestratorTools } from "../orchestrator_tools.js";
import type { McpRuntime } from "../runtime.js";
import { requireMcpMutationActor } from "./caller_session.js";

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

function agent(callerSessionId?: string) {
  const actor = requireMcpMutationActor(callerSessionId, "card mutation");
  return actor;
}
