/**
 * Resolve the structural caller link stored on a delegated session.
 *
 * Fire-and-forget sessions still inherit caller context and caller_info, but
 * they are independent work items rather than children in the delegation
 * tree. Keeping this policy at the creation boundary prevents server and UI
 * consumers from inventing their own notify_completion exceptions.
 */
export function resolveStructuralCallerSessionId(
  callerSessionId: string | null | undefined,
  notifyCompletion: boolean | undefined,
): string | null {
  if (notifyCompletion === false) return null;
  return callerSessionId ?? null;
}
