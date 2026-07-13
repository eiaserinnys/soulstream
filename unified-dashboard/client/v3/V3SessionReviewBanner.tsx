import { useEffect, useRef, useState } from "react";
import {
  SessionReviewAcknowledgeError,
  acknowledgeSessionReview,
  type SessionReviewAcknowledgeResult,
  type SessionSummary,
} from "@seosoyoung/soul-ui";

export function V3SessionReviewBanner({
  session,
  onAcknowledged,
}: {
  session: SessionSummary | undefined;
  onAcknowledged(result: SessionReviewAcknowledgeResult): void;
}) {
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
      setMessage(result.changed ? "검수를 확인했습니다." : "이미 확인된 세션입니다.");
      onAcknowledged(result);
    } catch (error) {
      if (sessionIdRef.current === requestedId) setMessage(reviewErrorMessage(error));
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
      <p><strong>{message ? "검수 상태" : "검수 대기"}</strong><small>{message ?? "이 세션의 결과 확인이 필요합니다."}</small></p>
      {!message ? <button type="button" disabled={pending} onClick={() => { void acknowledge(); }}>{pending ? "처리 중…" : "확인"}</button> : null}
    </div>
  );
}

function reviewErrorMessage(error: unknown): string {
  if (error instanceof SessionReviewAcknowledgeError) {
    if (error.status === 404) return "세션을 찾을 수 없습니다. 목록을 새로 고쳐주세요.";
    if (error.status === 409) return "검수 상태가 바뀌었습니다. 목록을 새로 고쳐주세요.";
    return `검수 확인 실패: ${error.detail}`;
  }
  return "서버에 연결할 수 없습니다. 잠시 뒤 다시 시도하세요.";
}
