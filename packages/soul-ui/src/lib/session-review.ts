export interface SessionReviewAcknowledgeResult {
  status: "ok";
  agentSessionId: string;
  reviewState: "acknowledged";
  changed: boolean;
}

export interface SessionReviewAcknowledgeErrorInput {
  status: number;
  code: string;
  message: string;
}

export class SessionReviewAcknowledgeError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;

  constructor(input: SessionReviewAcknowledgeErrorInput) {
    super(`${input.code}: ${input.message}`);
    this.name = "SessionReviewAcknowledgeError";
    this.status = input.status;
    this.code = input.code;
    this.detail = input.message;
  }
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
    throw new SessionReviewAcknowledgeError({ status: response.status, code, message });
  }
  return await response.json() as SessionReviewAcknowledgeResult;
}
