import { recurringJobTools } from "@soulstream/mcp-contract";
import { registerOrchestratorTools } from "../orchestrator_tools.js";
import { createCallerInfoPreprocessor } from "./cluster_caller_info.js";
export function registerRecurringJobTools(server: McpServer, runtime: McpRuntime): void {
  registerOrchestratorTools(server, runtime, Object.values(recurringJobTools), createCallerInfoPreprocessor(runtime));
}
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { RecurringJobHostClient } from "../../recurring-jobs/recurring_job_host_client.js";
import { isCurrentMcpCallerExternal } from "../request_context.js";
import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";
import { resolveMcpCallerAttribution } from "./caller_session.js";

type RecurringJobMcpActor = {
  readonly ownerEmail: string;
  readonly actorId: string;
  readonly callerInfo: Record<string, unknown>;
  readonly source: "agent";
};

export function registerRecurringJobToolsLegacy(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "list_recurring_jobs",
    recurringJobTools.list_recurring_jobs.config,
    async ({ include_archived, caller_session_id }) => await call(runtime, caller_session_id, "list", {
      include_archived: include_archived ?? false,
    }),
  );

  server.registerTool(
    "get_recurring_job",
    recurringJobTools.get_recurring_job.config,
    async ({ job_id, include_archived, caller_session_id }) => await call(runtime, caller_session_id, "get", {
      job_id,
      include_archived: include_archived ?? false,
    }),
  );

  server.registerTool(
    "preview_recurring_schedule",
    recurringJobTools.preview_recurring_schedule.config,
    async ({ timezone, schedule_expressions, caller_session_id }) => await call(runtime, caller_session_id, "preview", {
      timezone,
      schedule_expressions,
    }),
  );

  server.registerTool(
    "create_recurring_job",
    recurringJobTools.create_recurring_job.config,
    async (input) => await call(runtime, input.caller_session_id, "create", {
      name: input.name,
      prompt: input.prompt,
      idempotency_key: input.idempotency_key,
      timezone: input.timezone,
      ...(input.schedule_expressions === undefined
        ? {}
        : { schedule_expressions: input.schedule_expressions }),
      ...(input.run_at === undefined ? {} : { run_at: input.run_at }),
      node_id: input.node_id,
      agent_id: input.agent_id,
      model_preset: input.model_preset,
      folder_id: input.folder_id,
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.late_run_window_seconds === undefined
        ? {}
        : { late_run_window_seconds: input.late_run_window_seconds }),
    }),
  );

  server.registerTool(
    "update_recurring_job",
    recurringJobTools.update_recurring_job.config,
    async ({ caller_session_id, ...input }) => await call(runtime, caller_session_id, "update", input),
  );

  server.registerTool(
    "run_recurring_job",
    recurringJobTools.run_recurring_job.config,
    async ({ job_id, idempotency_key, caller_session_id }) => await call(runtime, caller_session_id, "run", {
      job_id,
      idempotency_key,
    }),
  );

  server.registerTool(
    "archive_recurring_job",
    recurringJobTools.archive_recurring_job.config,
    async ({ job_id, expected_version, caller_session_id }) => await call(runtime, caller_session_id, "archive", {
      job_id,
      expected_version,
    }),
  );

  server.registerTool(
    "list_recurring_job_runs",
    recurringJobTools.list_recurring_job_runs.config,
    async ({ job_id, limit, caller_session_id }) => await call(runtime, caller_session_id, "list_runs", {
      job_id,
      ...(limit === undefined ? {} : { limit }),
    }),
  );
}

/** External/LLM is a trust boundary, not a synonym for missing identity. */
export function resolveMcpRecurringJobActor(
  runtime: McpRuntime,
  callerSessionId: string | null | undefined,
): { ok: true; actor: RecurringJobMcpActor } | { ok: false; error: string } {
  if (isCurrentMcpCallerExternal()) {
    return { ok: false, error: "Recurring-job tools are not available to untrusted external or LLM callers." };
  }
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

async function call(
  runtime: McpRuntime,
  callerSessionId: string | null | undefined,
  operation: string,
  body: Record<string, unknown>,
) {
  const resolved = resolveMcpRecurringJobActor(runtime, callerSessionId);
  if (!resolved.ok) return errorResult(resolved.error);
  if (!runtime.orch) return errorResult("recurring jobs are not configured with an orchestrator");
  try {
    const client = new RecurringJobHostClient({ orch: runtime.orch, logger: runtime.logger });
    return jsonResult(await client.request(operation, { actor: resolved.actor, ...body }));
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}
