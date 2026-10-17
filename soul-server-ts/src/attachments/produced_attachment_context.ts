import type { Task } from "../task/task_models.js";
import type { ProducedAttachmentExecution } from "./produced_attachment_registration.js";

export function resolveProducedAttachmentExecutionContext(
  task: Task | undefined,
  sessionId: string,
  nodeId: string,
): ProducedAttachmentExecution | null {
  const workspaceDir = task?.resolvedWorkspaceDir ?? task?.runner?.engine.workspaceDir;
  const outputCommandId = task?.runner?.dispatcher.activeExecutionCommandId?.();
  if (
    !task ||
    typeof workspaceDir !== "string" ||
    !workspaceDir.trim() ||
    typeof outputCommandId !== "string" ||
    !outputCommandId.trim()
  ) {
    return null;
  }
  return {
    sessionId,
    nodeId,
    outputCommandId,
    workspaceDir,
    profileWorkspaceDir: task.agentProfileSnapshot?.workspace_dir,
  };
}
