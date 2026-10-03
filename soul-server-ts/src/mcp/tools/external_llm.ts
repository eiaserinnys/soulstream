import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { externalLlmTools } from "@soulstream/mcp-contract";
import { forwardOrchestratorTool } from "../orchestrator_tools.js";
import { getCurrentMcpCallerPrincipal, getCurrentMcpCallerSessionId } from "../request_context.js";
import { jsonResult, errorResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";

export function registerExternalLlmTools(server: McpServer, runtime: McpRuntime) {
  if (getCurrentMcpCallerPrincipal()?.authority === "external") return;
  const internal = () => getCurrentMcpCallerPrincipal()?.authority === "internal";
  server.registerTool("list_external_llm_recipients", externalLlmTools.list_external_llm_recipients.config, async () => {
    if (!internal()) return errorResult("internal_principal_required");
    if (!runtime.externalEvents) return forwardOrchestratorTool(runtime, externalLlmTools.list_external_llm_recipients, {});
    return jsonResult({ recipients: runtime.externalEvents.recipients() });
  });
  server.registerTool("send_to_external_llm", externalLlmTools.send_to_external_llm.config, async ({ recipient_id, text, title }) => {
    if (!internal()) return errorResult("internal_principal_required");
    if (!runtime.externalEvents) return forwardOrchestratorTool(runtime, externalLlmTools.send_to_external_llm, { recipient_id, text, title });
    const sender = getCurrentMcpCallerSessionId();
    if (!sender || !(await runtime.db.getSession(sender))) return errorResult("authenticated_sender_session_required");
    try { return jsonResult(await runtime.externalEvents.send(recipient_id, text, sender, title)); }
    catch { return errorResult("external_events_state_save_failed"); }
  });
}
