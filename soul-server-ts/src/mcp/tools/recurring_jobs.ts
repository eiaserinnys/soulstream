import { recurringJobTools } from "@soulstream/mcp-contract";
import { registerOrchestratorTools } from "../orchestrator_tools.js";
import { createCallerInfoPreprocessor } from "./cluster_caller_info.js";
export function registerRecurringJobTools(server: McpServer, runtime: McpRuntime): void {
  const attribution = createCallerInfoPreprocessor(runtime);
  registerOrchestratorTools(server, runtime, Object.values(recurringJobTools), Object.fromEntries(Object.keys(recurringJobTools).map(name => [name,
    (args: Record<string, unknown>) => {
      // With no transport, retain the legacy failure ordering; reachable hosts own validation.
      if (!runtime.orch) {
        const actor = resolveMcpRecurringJobActor(runtime, args.caller_session_id as string | undefined);
        return errorResult(actor.ok ? "recurring jobs are not configured with an orchestrator" : actor.error);
      }
      return attribution[name]!(args);
    },
  ])));
}
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { errorResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";
import { resolveMcpCallerAttribution } from "./caller_session.js";

type RecurringJobMcpActor = {
  readonly ownerEmail: string;
  readonly actorId: string;
  readonly callerInfo: Record<string, unknown>;
  readonly source: "agent";
};

/** External/LLM is a trust boundary, not a synonym for missing identity. */
export function resolveMcpRecurringJobActor(
  runtime: McpRuntime,
  callerSessionId: string | null | undefined,
): { ok: true; actor: RecurringJobMcpActor } | { ok: false; error: string } {
  const attribution = resolveMcpCallerAttribution(runtime, callerSessionId);
  const email = attribution.callerInfo?.email;
  if (!attribution.callerSessionId) {
    return { ok: false, error: "A trusted Soulstream caller session is required for recurring-job tools." };
  }
  if (typeof email !== "string" || !email.trim()) {
    return { ok: false, error: "The trusted caller session has no verified owner email for recurring-job access." };
  }
  return {
    ok: true,
    actor: {
      ownerEmail: email,
      actorId: attribution.callerSessionId,
      callerInfo: attribution.callerInfo as Record<string, unknown>,
      source: "agent",
    },
  };
}
