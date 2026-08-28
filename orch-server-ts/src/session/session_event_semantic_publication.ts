export type SessionEventSemanticPublication = {
  eventType: string;
  sessionEffectApplied?: boolean;
};

export function shouldPublishSessionEventSemantically(
  publication: SessionEventSemanticPublication,
): boolean {
  return !(
    publication.eventType === "session_ended"
    && publication.sessionEffectApplied === false
  );
}
