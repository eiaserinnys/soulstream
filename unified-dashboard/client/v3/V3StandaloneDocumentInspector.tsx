import { useRef } from "react";
import {
  DashboardIconCap,
  MarkdownDocumentPanel,
  useGlassSurface,
} from "@seosoyoung/soul-ui";
import type { BoardContainerRef } from "@seosoyoung/soul-ui";
import { X } from "lucide-react";

export function V3StandaloneDocumentInspector({
  open,
  documentId,
  container,
  onClose,
  onDeleted,
}: {
  open: boolean;
  documentId: string | null;
  container: BoardContainerRef | null;
  onClose(): void;
  onDeleted(boardItemId: string, documentId: string): void;
}) {
  const surfaceRef = useRef<HTMLElement>(null);
  const webglActive = useGlassSurface(surfaceRef, { enabled: open });
  if (!open) return null;

  const close = () => {
    onClose();
  };

  return (
    <div className="v3-workspace-scrim v3-standalone-inspector-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div className="v3-workspace is-chat-open" data-mobile-view="chat">
        <section
          ref={surfaceRef}
          className="v3-chat-pane border border-glass-border glass-strong glass-chrome lg-rim"
          data-liquid-glass-webgl={webglActive ? "true" : undefined}
          data-testid="v3-standalone-document-panel"
          aria-label="마크다운 문서"
        >
          <header className="v3-chat-header">
            <div><small>프로젝트 문서</small><strong>마크다운 문서</strong></div>
            <DashboardIconCap label="문서 패널 닫기" onClick={close}>
              <X className="h-4 w-4" aria-hidden="true" />
            </DashboardIconCap>
          </header>
          <div className="v3-board-document-content">
            <MarkdownDocumentPanel
              documentId={documentId}
              container={container}
              pendingEditId={null}
              onPendingEditConsumed={() => undefined}
              onClose={onClose}
              onDeleted={onDeleted}
            />
          </div>
        </section>
      </div>
    </div>
  );
}
