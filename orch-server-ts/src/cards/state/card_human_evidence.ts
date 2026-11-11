/** Raw SQL results become evidence here, shared by live services and fixture replay. */
export function humanCardEvidence(
  sessions: readonly { session_id: string }[],
  sessionId: string | null | undefined,
  userInput: boolean,
) {
  return { claim: sessions.some(session => session.session_id === sessionId), userInput };
}
