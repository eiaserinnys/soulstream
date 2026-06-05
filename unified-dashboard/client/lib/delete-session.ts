export async function deleteSessions(sessionIds: string[]): Promise<void> {
  const responses = await Promise.all(
    sessionIds.map((sessionId) =>
      fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      }),
    ),
  );
  const failed = responses.find((response) => !response.ok);
  if (failed) {
    throw new Error(`Failed to delete session: ${failed.status}`);
  }
}
