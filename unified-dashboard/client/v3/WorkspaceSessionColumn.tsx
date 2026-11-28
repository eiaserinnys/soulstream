import { useTranslation } from "react-i18next";
import { useRef, type KeyboardEventHandler, type AriaAttributes } from "react";
import {
  DragHandle,
  useGlassSurface,
  type SessionProviderConnectionStatus, type SessionReviewAcknowledgeResult,
  type SessionSummary, type ChatSessionStoreScope,
} from "@seosoyoung/soul-ui";
import { V3_PANEL_GAP_PX } from "./v3-layout-metrics";
import { SessionPanelHeader } from "./WorkspacePanelHeaders";
import { V3SessionReviewBanner } from "./V3SessionReviewBanner";
import { PersistentSessionChatView } from "./PersistentSessionChatView";

/** The folder board's resize handle and session column, shared with card overlays. */
export function WorkspaceSessionColumn({
  activeSession, chatClassName, chatTestId, resizeClassName, resizeTestId,
  onResize, onResizeKeyDown, onClose, chatInputDisabled, fileUploadUrl,
  historyEnabled, sessionStreamActive, sessionConnectionStatus, reconnectSession,
  onAcknowledgedReview,separatorAria,
  storeScope,onSessionChange,loadDisplaySettings,filesOpen,onToggleFiles,cardSessionCount,
}: {
  activeSession: SessionSummary | undefined;
  chatClassName: string; chatTestId: string;
  resizeClassName: string; resizeTestId: string;
  onResize(deltaPercent: number): void;
  onResizeKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  onClose?(): void;
  chatInputDisabled: boolean; fileUploadUrl?: string;
  historyEnabled: boolean; sessionStreamActive: boolean;
  sessionConnectionStatus: SessionProviderConnectionStatus;
  reconnectSession(): void;
  onAcknowledgedReview(result: SessionReviewAcknowledgeResult): void;
  storeScope?: ChatSessionStoreScope;
  onSessionChange?(sessionId: string): void;
  loadDisplaySettings?: boolean;
  filesOpen?: boolean; onToggleFiles?(): void;
  /** 카드 화면에서만 넘긴다. 0이면 세션이 아직 하나도 없는 카드다. */
  cardSessionCount?: number;
  separatorAria?:Pick<AriaAttributes,"aria-valuenow"|"aria-valuemin"|"aria-valuemax"|"aria-valuetext">;
}) {
  const { t } = useTranslation();
  const chatSurfaceRef = useRef<HTMLElement>(null);
  const chatWebglActive = useGlassSurface(chatSurfaceRef, { enabled: true });
  const resizeKey: KeyboardEventHandler<HTMLDivElement> = onResizeKeyDown ?? (event => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    // Preserve the folder workspace's existing keyboard step and drag sign.
    onResize((event.key === "ArrowLeft" ? -24 : 24) * 100 / document.documentElement.clientWidth);
  });
  return <>
    <div className={resizeClassName} data-testid={resizeTestId} role="separator"
      aria-orientation="vertical" aria-label={t("sessions.resizeChat")} {...separatorAria} tabIndex={0} onKeyDown={resizeKey}>
      <DragHandle onDrag={onResize} widthPx={V3_PANEL_GAP_PX}/>
    </div>
    <section ref={chatSurfaceRef}
      className={`v3-chat-pane ${chatClassName} border border-glass-border glass-strong glass-chrome lg-rim`}
      data-liquid-glass-webgl={chatWebglActive ? "true" : undefined}
      data-testid={chatTestId} aria-label={t("sessions.sessionChat")}>
      <SessionPanelHeader session={activeSession} streamActive={sessionStreamActive}
        connectionStatus={sessionConnectionStatus} reconnect={reconnectSession} onClose={onClose} filesOpen={filesOpen} onToggleFiles={onToggleFiles}/>
      {activeSession ? <V3SessionReviewBanner session={activeSession} onAcknowledged={onAcknowledgedReview}/> : null}
      <div className="v3-chat-content">
        {activeSession ? <PersistentSessionChatView sessionId={activeSession.agentSessionId} storeScope={storeScope} onSessionChange={onSessionChange} loadDisplaySettings={loadDisplaySettings} chatInputDisabled={chatInputDisabled} fileUploadUrl={fileUploadUrl} historyEnabled={historyEnabled}/> :
          <div className="v3-chat-empty"><span className="v3-emoji" aria-hidden="true">💬</span><strong>{cardSessionCount===0?t("sessions.noStartedSessions"):t("sessions.chooseDelegatedSession")}</strong><p>{t("sessions.chatPersistent")}</p></div>}
      </div>
    </section>
  </>;
}
