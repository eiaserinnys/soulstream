import { useEffect, useRef, useState } from "react";
import { CircleCheck, ShieldAlert } from "lucide-react";

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
  Button,
  SessionReviewAcknowledgeError,
  acknowledgeSessionReview,
  type SessionReviewAcknowledgeResult,
  type SessionSummary,
} from "@seosoyoung/soul-ui";

export interface V2SessionReviewBannerProps {
  session: SessionSummary | undefined;
  onAcknowledged(result: SessionReviewAcknowledgeResult): void;
}

export function V2SessionReviewBanner({
  session,
  onAcknowledged,
}: V2SessionReviewBannerProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const sessionIdRef = useRef(session?.agentSessionId);
  sessionIdRef.current = session?.agentSessionId;

  useEffect(() => {
    pendingRef.current = false;
    setPending(false);
    setError(null);
    setOutcome(null);
  }, [session?.agentSessionId]);

  const needsReview = session?.reviewRequired === true
    && session.reviewState === "needs_review";
  if (!needsReview && outcome === null) return null;

  if (outcome !== null) {
    return (
      <Alert
        data-testid="v2-session-review-result"
        role="status"
        variant="success"
        className="shrink-0 rounded-none border-x-0 border-t-0"
      >
        <CircleCheck aria-hidden="true" />
        <AlertTitle>Session review</AlertTitle>
        <AlertDescription>{outcome}</AlertDescription>
      </Alert>
    );
  }

  const acknowledge = async () => {
    if (!session || pendingRef.current) return;
    const requestedSessionId = session.agentSessionId;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await acknowledgeSessionReview(requestedSessionId);
      if (sessionIdRef.current !== requestedSessionId) return;
      setOutcome(result.changed
        ? "Review acknowledged."
        : "Review was already acknowledged.");
      onAcknowledged(result);
    } catch (caught) {
      if (sessionIdRef.current !== requestedSessionId) return;
      setError(reviewErrorMessage(caught));
    } finally {
      if (sessionIdRef.current === requestedSessionId) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  };

  return (
    <Alert
      data-testid="v2-session-review"
      variant={error ? "error" : "warning"}
      className="shrink-0 rounded-none border-x-0 border-t-0"
    >
      <ShieldAlert aria-hidden="true" />
      <AlertTitle>Review required</AlertTitle>
      <AlertDescription>
        <span>{error ?? "This session finished and is waiting for your review."}</span>
      </AlertDescription>
      <AlertAction>
        <Button
          data-testid="v2-session-review-acknowledge"
          size="sm"
          variant="warning"
          disabled={pending}
          onClick={() => { void acknowledge(); }}
        >
          {pending ? "Acknowledging…" : "Acknowledge"}
        </Button>
      </AlertAction>
    </Alert>
  );
}

function reviewErrorMessage(error: unknown): string {
  if (error instanceof SessionReviewAcknowledgeError) {
    if (error.status === 404) {
      return "Session no longer exists. Review remains visible until the session list refreshes.";
    }
    if (error.status === 409) {
      return "Review state changed on the server. Review remains visible until the session list refreshes.";
    }
    return `Review could not be acknowledged: ${error.detail}`;
  }
  return "Could not reach the server. Review remains pending; try again.";
}
