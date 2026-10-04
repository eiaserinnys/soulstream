/** Missing total preserves the legacy snapshot contract; a reported partial page cannot replace membership. */
export function isCompleteSessionSnapshot(sessions: unknown, total?: number): boolean {
  return total === undefined || (Array.isArray(sessions) && sessions.length >= total);
}
