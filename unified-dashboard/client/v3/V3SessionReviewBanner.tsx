import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import {
  DashboardIconCap,
  SessionReviewAcknowledgeError,
  acknowledgeSessionReview,
  type SessionReviewAcknowledgeResult,
  type SessionSummary,
} from "@seosoyoung/soul-ui";
import { Check } from "lucide-react";

type Translate = ReturnType<typeof useTranslation>["t"];

export function V3SessionReviewBanner({
  session,
  onAcknowledged,
}: {
  session: SessionSummary | undefined;
  onAcknowledged(result: SessionReviewAcknowledgeResult): void;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const sessionIdRef = useRef(session?.agentSessionId);
  sessionIdRef.current = session?.agentSessionId;

  useEffect(() => {
    pendingRef.current = false;
    setPending(false);
    setMessage(null);
  }, [session?.agentSessionId]);

  const needsReview = session?.reviewRequired === true && session.reviewState === "needs_review";
  if (!needsReview && message === null) return null;

  const acknowledge = async () => {
    if (!session || pendingRef.current) return;
    const requestedId = session.agentSessionId;
    pendingRef.current = true;
    setPending(true);
    setMessage(null);
    try {
      const result = await acknowledgeSessionReview(requestedId);
      if (sessionIdRef.current !== requestedId) return;
      setMessage(result.changed ? t("sessions.reviewAcknowledged") : t("sessions.alreadyAcknowledged"));
      onAcknowledged(result);
    } catch (error) {
      if (sessionIdRef.current === requestedId) setMessage(reviewErrorMessage(error, t));
    } finally {
      if (sessionIdRef.current === requestedId) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  };

  return (
    <div className={`v3-review-banner${message ? " has-message" : ""}`} role="status">
      <span aria-hidden="true">{message ? "✓" : "◆"}</span>
      <p><strong>{message ? t("sessions.reviewStatus") : t("sessions.needsReview")}</strong><small>{message ?? t("sessions.reviewPrompt")}</small></p>
      {!message ? (
        <DashboardIconCap label={t("sessions.acknowledgeReview")} disabled={pending} onClick={() => { void acknowledge(); }}>
          <Check className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
      ) : null}
    </div>
  );
}

export function reviewErrorMessage(error: unknown, t: Translate): string {
  if (error instanceof SessionReviewAcknowledgeError) {
    if (error.status === 404) return t("sessions.sessionMissingRefresh");
    if (error.status === 409) return t("sessions.reviewChangedRefresh");
    return t("sessions.reviewError", { detail: error.detail });
  }
  return t("sessions.serverUnreachable");
}
