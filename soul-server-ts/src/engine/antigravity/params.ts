import { antigravityTransportEfforts } from "../effort_boundary.js";
import type { EngineExecuteParams } from "../protocol.js";

export interface AntigravityAgentSelection { name: string }

export function antigravityArguments(
  params: EngineExecuteParams,
  logPath: string,
  definition?: AntigravityAgentSelection,
): string[] {
  if (params.reasoningEffort !== undefined && !antigravityTransportEfforts().includes(params.reasoningEffort)) {
    throw new Error(`Unsupported Antigravity effort: ${params.reasoningEffort}`);
  }
  const args = ["--output-format", "stream-json", "--input-format", "stream-json",
    "--dangerously-skip-permissions", "--log-file", logPath];
  if (params.model) args.push("--model", params.model);
  if (params.reasoningEffort !== undefined) args.push("--effort", params.reasoningEffort);
  if (params.resumeSessionId) args.push("--conversation", params.resumeSessionId);
  else if (definition) args.push("--agent", definition.name);
  return args;
}

export function antigravityUserMessage(content: string): string {
  return JSON.stringify({ event: "user", message: { content } }) + "\n";
}
