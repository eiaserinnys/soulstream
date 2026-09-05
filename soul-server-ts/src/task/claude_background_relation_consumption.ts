import type { ClaudeBackgroundTaskRepository } from
  "../db/repositories/claude_background_task_repository.js";
import type { SessionDeliveryRepository } from
  "../db/repositories/session_delivery_repository.js";

import { buildClaudeBackgroundGenerationIdentity } from
  "./claude_background_generation_identity.js";
import type { ClaudeBackgroundConsumptionProof } from
  "./claude_background_result_consumption.js";
import type { Task } from "./task_models.js";

export async function recordClaudeBackgroundRelationConsumption(
  repository: Pick<SessionDeliveryRepository, "recordRelationConsumed">,
  backgroundRepository: Pick<ClaudeBackgroundTaskRepository, "resolveGeneration">,
  sourceNode: string,
  task: Task,
  proof: ClaudeBackgroundConsumptionProof,
  consumedTurnId: string,
): Promise<boolean> {
  const sdkSessionId = task.codexThreadId;
  if (!sdkSessionId) return false;
  let relationKey: string;
  let completionId: string;
  if (proof.kind === "exact_generation") {
    const identity = buildClaudeBackgroundGenerationIdentity({
      sourceNode,
      agentSessionId: task.agentSessionId,
      sdkSessionId,
      sdkTaskId: proof.taskId,
      initiatingToolUseId: proof.initiatingToolUseId,
    });
    relationKey = identity.relationKey;
    completionId = identity.completionId;
  } else {
    const resolved = await backgroundRepository.resolveGeneration(
      sourceNode,
      task.agentSessionId,
      sdkSessionId,
      proof.taskId,
    );
    if (resolved.status !== "resolved") return false;
    relationKey = resolved.row.relation_key;
    completionId = resolved.row.completion_id;
  }
  await repository.recordRelationConsumed({
    relationKey,
    completionId,
    callerSessionId: task.agentSessionId,
    consumedTurnId,
  });
  return true;
}
