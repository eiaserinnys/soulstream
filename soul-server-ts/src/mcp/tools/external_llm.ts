import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCurrentMcpCallerPrincipal, getCurrentMcpCallerSessionId } from "../request_context.js";
import { jsonResult, errorResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";

export function registerExternalLlmTools(server: McpServer, runtime: McpRuntime) {
  if (getCurrentMcpCallerPrincipal()?.authority === "external") return;
  const internal = () => getCurrentMcpCallerPrincipal()?.authority === "internal";
  server.registerTool("list_external_llm_recipients", {
    description: "Internal only. List active verified subscriptions. recipient_label is self-reported, not verified dot identity. No callback URLs or secrets are returned.",
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, async () => internal() ? jsonResult({ recipients: runtime.externalEvents?.recipients() ?? [] }) : errorResult("internal_principal_required"));
  server.registerTool("send_to_external_llm", {
    description: "Internal only. Send user data to exactly one active recipient_id. accepted_by_receiver confirms receipt only, not reading or processing. No automatic recipient selection or broadcast.",
    inputSchema: { recipient_id: z.string(), text: z.string(), title: z.string().optional() },
  }, async ({ recipient_id, text, title }) => {
    if (!internal()) return errorResult("internal_principal_required");
    const sender = getCurrentMcpCallerSessionId();
    if (!sender || !(await runtime.db.getSession(sender))) return errorResult("authenticated_sender_session_required");
    if (!runtime.externalEvents) return jsonResult({ ok: false, status: "not_sent", reason: "no_active_recipient" });
    try { return jsonResult(await runtime.externalEvents.send(recipient_id, text, sender, title)); }
    catch { return errorResult("external_events_state_save_failed"); }
  });
}
