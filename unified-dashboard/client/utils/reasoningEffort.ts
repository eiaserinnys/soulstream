import type { ReasoningEffort } from "@seosoyoung/soul-ui";

const DEFAULT_REASONING_EFFORT: ReasoningEffort = "xhigh";

export type ReasoningBackend = "codex";

export function backendSupportsReasoningEffort(
  backend: string | null | undefined,
): backend is ReasoningBackend {
  return backend === "codex";
}

export function selectedAgentBackend<T extends { id: string; backend?: string | null }>(
  agents: T[],
  selectedAgentId: string,
): string | null {
  if (!selectedAgentId) return null;
  return agents.find((agent) => agent.id === selectedAgentId)?.backend ?? null;
}

export function reasoningEffortForSubmit(
  backend: string | null | undefined,
  selected: ReasoningEffort = DEFAULT_REASONING_EFFORT,
): ReasoningEffort | undefined {
  return backendSupportsReasoningEffort(backend) ? selected : undefined;
}
