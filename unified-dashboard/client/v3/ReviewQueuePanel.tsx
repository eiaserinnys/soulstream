import { useEffect, useState } from "react";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  SessionReviewAcknowledgeError,
  acknowledgeSessionReview,
  type SessionReviewAcknowledgeResult,
  type SessionSummary,
} from "@seosoyoung/soul-ui";

import { reviewQueueSessions, reviewSessionPreview, reviewSessionTitle } from "./review-queue-model";
import { RichSessionRow } from "./RichSessionRow";
import "./v3-review-queue.css";

export function ReviewQueuePanel({
  open,
  sessions,
  onClose,
  onOpenSession,
  onAcknowledged,
}: {
  open: boolean;
  sessions: readonly SessionSummary[];
  onClose(): void;
  onOpenSession(session: SessionSummary): void;
  onAcknowledged(result: SessionReviewAcknowledgeResult): void;
}) {
  const visible = reviewQueueSessions(sessions);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setPendingId(null);
      setError(null);
    }
  }, [open]);

  const acknowledge = async (session: SessionSummary) => {
    if (pendingId) return;
    setPendingId(session.agentSessionId);
    setError(null);
    try {
      onAcknowledged(await acknowledgeSessionReview(session.agentSessionId));
    } catch (caught) {
      setError(reviewErrorMessage(caught));
    } finally {
      setPendingId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !pendingId) onClose(); }}>
      <DialogPopup className="v3-review-queue-popup">
        <DialogHeader>
          <DialogTitle>검수 대기</DialogTitle>
          <span>{visible.length}건</span>
        </DialogHeader>
        <DialogPanel>
          <p className="v3-review-queue-intro">완료된 세션의 결과를 확인하고 검수 상태를 정리합니다.</p>
          <div className="v3-review-queue-list" data-testid="v3-review-queue-list">
            {visible.map((session) => (
              <RichSessionRow
                key={session.agentSessionId}
                session={session}
                preview={reviewSessionPreview(session)}
                onOpen={(selected) => { onClose(); onOpenSession(selected); }}
                actions={(
                  <>
                    <button
                      type="button"
                      className="v3-button v3-button--ghost"
                      onClick={() => { onClose(); onOpenSession(session); }}
                    >
                      채팅 열기
                    </button>
                    <button
                      type="button"
                      className="v3-button v3-button--soft"
                      disabled={pendingId !== null}
                      aria-label={`${reviewSessionTitle(session)} 확인 처리`}
                      onClick={() => { void acknowledge(session); }}
                    >
                      {pendingId === session.agentSessionId ? "처리 중…" : "확인 처리"}
                    </button>
                  </>
                )}
              />
            ))}
            {visible.length === 0 ? <p className="v3-detail-empty">검수 대기 세션이 없습니다.</p> : null}
          </div>
          {error ? <p className="v3-load-error" role="alert">{error}</p> : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
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
