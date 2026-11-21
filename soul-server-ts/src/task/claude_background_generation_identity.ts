import { buildDeterministicDeliveryIdentity } from "@soulstream/wire-schema/delivery";

export interface ClaudeBackgroundGenerationInput {
  sourceNode: string;
  agentSessionId: string;
  sdkSessionId: string;
  sdkTaskId: string;
  initiatingToolUseId: string;
}

export interface ClaudeBackgroundGenerationIdentity {
  generationKey: string;
  relationKey: string;
  completionId: string;
  deliveryId: string;
}

export function buildClaudeBackgroundResumeId(originalId: string, number: number): string {
  return `${originalId}#r${number}`;
}

export function originalClaudeBackgroundToolUseId(id: string): string {
  return id.replace(/#r\d+$/, "");
}

/**
 * One Claude background execution generation. Terminal state, revision and
 * output are deliberately absent: they refine a generation, never identify it.
 */
export function buildClaudeBackgroundGenerationIdentity(
  input: ClaudeBackgroundGenerationInput,
): ClaudeBackgroundGenerationIdentity {
  for (const [name, value] of Object.entries(input)) {
    if (value.length === 0) throw new Error(`${name} is required`);
  }
  const relationKey = [
    "claude_runtime_generation:v1",
    input.sourceNode,
    input.agentSessionId,
    input.sdkSessionId,
    input.sdkTaskId,
    input.initiatingToolUseId,
  ].map(encodeURIComponent).join(":");
  const identity = buildDeterministicDeliveryIdentity({
    targetSessionId: input.agentSessionId,
    relationKey,
    intent: "runtime_followup",
  });
  return {
    generationKey: relationKey,
    relationKey,
    completionId: identity.completionId,
    deliveryId: identity.deliveryId,
  };
}
