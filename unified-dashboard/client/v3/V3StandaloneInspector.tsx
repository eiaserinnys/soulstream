import { useRef } from "react";
import {
  ChatView,
  MarkdownDocumentPanel,
  useDashboardStore,
  useGlassSurface,
  type SessionReviewAcknowledgeResult,
  type SessionSummary,
} from "@seosoyoung/soul-ui";

import { V3SessionReviewBanner } from "./V3SessionReviewBanner";

export function V3StandaloneInspector({
  open,
  session,
  chatInputDisabled,
  fileUploadUrl,
  onClose,
  onAcknowledgedReview,
}: {
  open: boolean;
  session: SessionSummary | undefined;
  chatInputDisabled: boolean;
  fileUploadUrl: string | undefined;
  onClose(): void;
  onAcknowledgedReview(result: SessionReviewAcknowledgeResult): void;
}) {
  const surfaceRef = useRef<HTMLElement>(null);
  const activeBoardDocumentId = useDashboardStore((state) => state.activeBoardDocumentId);
  const webglActive = useGlassSurface(surfaceRef, { enabled: open });
  if (!open) return null;

  const close = () => {
    if (activeBoardDocumentId) useDashboardStore.getState().setActiveBoardDocument(null);
    onClose();
  };
  const documentOpen = Boolean(activeBoardDocumentId);

  return (
    <div className="v3-workspace-scrim v3-standalone-inspector-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div className="v3-workspace is-chat-open" data-mobile-view="chat">
        <section
          ref={surfaceRef}
          className="v3-chat-pane border border-glass-border glass-strong glass-chrome lg-rim"
          data-liquid-glass-webgl={webglActive ? "true" : undefined}
          data-testid={documentOpen ? "v3-standalone-document-panel" : "v3-standalone-chat-panel"}
          aria-label={documentOpen ? "마크다운 문서" : "검수 세션 채팅"}
        >
          <header className="v3-chat-header">
            <div>
              <small>{documentOpen ? "프로젝트 문서" : "검수 대기"}</small>
              <strong>{documentOpen ? "마크다운 문서" : session?.displayName ?? session?.agentName ?? "세션"}</strong>
            </div>
            {!documentOpen ? <span className={`v3-chat-status v3-chat-status--${session?.status ?? "unknown"}`}>{session?.status === "running" ? "실행 중" : "완료"}</span> : null}
            <button type="button" aria-label="우측 패널 닫기" onClick={close}>×</button>
          </header>
          {documentOpen ? (
            <div className="v3-board-document-content"><MarkdownDocumentPanel /></div>
          ) : (
            <>
              <V3SessionReviewBanner session={session} onAcknowledged={onAcknowledgedReview} />
              <div className="v3-chat-content">
                {session ? <ChatView chatInputDisabled={chatInputDisabled} fileUploadUrl={fileUploadUrl} showHeader={false} /> : <div className="v3-chat-empty"><strong>세션을 찾을 수 없습니다.</strong></div>}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
