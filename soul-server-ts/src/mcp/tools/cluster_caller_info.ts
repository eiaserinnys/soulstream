import type { McpForwardPreprocessor } from "../orchestrator_tools.js";
import type { McpRuntime } from "../runtime.js";
import { resolveMcpCallerAttribution } from "./caller_session.js";

/** Attribution needs the worker's task/profile registry; validation belongs to the host. */
export function createCallerInfoPreprocessor(runtime: McpRuntime): Record<string, McpForwardPreprocessor> {
  const preprocess: McpForwardPreprocessor = args => ({
    callerInfo: resolveMcpCallerAttribution(runtime, args.caller_session_id as string | undefined).callerInfo,
  });
  return Object.fromEntries([
    "list_recurring_jobs", "get_recurring_job", "preview_recurring_schedule", "create_recurring_job",
    "update_recurring_job", "run_recurring_job", "archive_recurring_job", "list_recurring_job_runs",
    "create_remote_agent_session",
  ].map(name => [name, preprocess]));
}
