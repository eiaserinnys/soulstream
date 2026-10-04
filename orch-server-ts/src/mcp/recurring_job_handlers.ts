import { withVerifiedSessionOwner } from "../session/session_owner.js";
import { STATUS_CODES } from "node:http";
import { recurringJobTools, errorResult, jsonResult, readOrchErrorEnvelopeText, type CallToolResult } from "@soulstream/mcp-contract";
import { executeRecurringJobHostOperation } from "../recurring-jobs/recurring_job_host_routes.js";
import type { McpCallContext, McpHostOptions } from "./types.js";

type Args = Record<string, unknown>;
type Handler = (options: McpHostOptions, args: Args, context: McpCallContext) => Promise<CallToolResult>;
const invoke = (operation: string, body: (args: Args) => Args): Handler => async (options, args, context) => {
  const explicit = typeof args.caller_session_id === "string" ? args.caller_session_id.trim() : "";
  try {
    let actor;
    if (context.principal === "external") {
      if (!context.ownedAgent) return errorResult("Recurring-job tools require a registered external agent.");
      actor = { ownerEmail: context.ownedAgent.ownerEmail, actorId: context.ownedAgent.agentId,
        callerInfo: context.callerInfo!, source: "external-llm" as const };
    } else {
      if (explicit && context.callerSessionId && explicit !== context.callerSessionId)
        return errorResult("caller_session_id does not match authenticated session");
      const id = context.callerSessionId || explicit;
      if (!id) return errorResult("A trusted Soulstream caller session is required for recurring-job tools.");
      const owner = await options.resolveSessionOwner?.(id);
      if (!owner) return errorResult("The trusted caller session has no verified owner email for recurring-job access.");
      actor = { ownerEmail: owner.ownerEmail, actorId: id, callerInfo: withVerifiedSessionOwner(context.callerInfo, owner)!, source: "agent" as const };
    }
    const response = await executeRecurringJobHostOperation(options.recurringJobs.service, operation, {
      actor, ...body(args),
    });
    const serialized = JSON.parse(JSON.stringify(response.body));
    if (response.status !== 200) {
      const detail = readOrchErrorEnvelopeText({ status: response.status, statusText: STATUS_CODES[response.status] ?? "" }, JSON.stringify(serialized));
      return errorResult(`recurring job host ${operation} failed: ${detail.message}`);
    }
    return jsonResult(serialized);
  } catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
};
export const recurringJobHandlers = {
  list_recurring_jobs: invoke("list", a => ({ include_archived: a.include_archived ?? false })),
  get_recurring_job: invoke("get", a => ({ job_id: a.job_id, include_archived: a.include_archived ?? false })),
  preview_recurring_schedule: invoke("preview", a => ({ timezone: a.timezone, schedule_expressions: a.schedule_expressions })),
  create_recurring_job: invoke("create", a => {
    const { caller_session_id: _caller, ...input } = a;
    return input;
  }),
  update_recurring_job: invoke("update", a => { const { caller_session_id: _caller, ...input } = a; return input; }),
  run_recurring_job: invoke("run", a => ({ job_id: a.job_id, idempotency_key: a.idempotency_key })),
  archive_recurring_job: invoke("archive", a => ({ job_id: a.job_id, expected_version: a.expected_version })),
  list_recurring_job_runs: invoke("list_runs", a => ({ job_id: a.job_id, ...(a.limit === undefined ? {} : { limit: a.limit }) })),
} satisfies Record<keyof typeof recurringJobTools, Handler>;
