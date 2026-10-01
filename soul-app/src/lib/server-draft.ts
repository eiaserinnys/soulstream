export function mergeServerDraft(
  draft: string,
  previousServer: string,
  incomingServer: string,
) {
  if (draft !== previousServer) return { draft, server: previousServer };
  return { draft: incomingServer, server: incomingServer };
}
