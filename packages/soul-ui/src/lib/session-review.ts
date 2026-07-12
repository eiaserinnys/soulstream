export interface SessionReviewAcknowledgeResult {
  status: "ok";
  agentSessionId: string;
  reviewState: "acknowledged";
  changed: boolean;
}

export async function acknowledgeSessionReview(
  sessionId: string,
): Promise<SessionReviewAcknowledgeResult> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/review/acknowledge`,
    { method: "POST", credentials: "same-origin" },
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as
      | { error?: { code?: string; message?: string } }
      | undefined;
    const code = payload?.error?.code ?? "REVIEW_ACKNOWLEDGE_FAILED";
    const message = payload?.error?.message ?? `Review acknowledge failed (${response.status})`;
    throw new Error(`${code}: ${message}`);
  }
  return await response.json() as SessionReviewAcknowledgeResult;
}
