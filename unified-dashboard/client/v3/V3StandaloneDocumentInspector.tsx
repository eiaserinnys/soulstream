import { useRef } from "react";
import {
  MarkdownDocumentPanel,
  useDashboardStore,
  useGlassSurface,
} from "@seosoyoung/soul-ui";

export function V3StandaloneDocumentInspector({
  open,
  onClose,
}: {
  open: boolean;
  onClose(): void;
}) {
  const surfaceRef = useRef<HTMLElement>(null);
  const webglActive = useGlassSurface(surfaceRef, { enabled: open });
  if (!open) return null;

  const close = () => {
    useDashboardStore.getState().setActiveBoardDocument(null);
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
            <button type="button" aria-label="문서 패널 닫기" onClick={close}>×</button>
          </header>
          <div className="v3-board-document-content"><MarkdownDocumentPanel /></div>
        </section>
      </div>
    </div>
  );
}
