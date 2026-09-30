/** The termination signal used by the existing ResumeAfterLimit eligibility path. */
export function isUsageLimitTermination(session: Readonly<Record<string, unknown>>): boolean {
    const eventId = Number(session.termination_event_id);
    return session.status === "error" && session.termination_reason === "limit_hit" && Number.isSafeInteger(eventId) && eventId > 0;
}
