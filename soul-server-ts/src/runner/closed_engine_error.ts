/**
 * Compatibility classifier for runner children released before closed-engine
 * failures had a dedicated wire capability.
 */
export function isClosedClaudeEngineFailure(
  backend: string | undefined,
  failure: unknown,
): boolean {
  if (backend !== "claude" || typeof failure !== "object" || failure === null) {
    return false;
  }
  const candidate = failure as Record<string, unknown>;
  // Older runner releases expose only this exact execution_failed message.
  return candidate.code === "execution_failed"
    && candidate.message === "ClaudeEngineAdapter.execute called after close()";
}
