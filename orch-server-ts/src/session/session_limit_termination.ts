/** The termination signal used by the existing ResumeAfterLimit eligibility path. */
export function isUsageLimitTermination(session: {
  status: unknown; termination_reason?: unknown; termination_event_id?: unknown;
}): boolean {
  const eventId=Number(session.termination_event_id);
  return session.status === "error" && session.termination_reason === "limit_hit" && Number.isSafeInteger(eventId) && eventId>0;
}
