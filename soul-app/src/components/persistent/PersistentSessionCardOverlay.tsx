import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, useWindowDimensions } from 'react-native';
import type { ApiClient } from '../../api/client';
import { CardDetailChatPanes, CardPanelOverlayFrame } from '../planner/FolderWorkspaceReadOverlay';
import { useCardStore } from '../../store/cardStore';
import { getCardDetailPaneWidth, getFolderWorkspaceOverlayWidth } from '../../lib/folder-workspace-layout';
import { useDeviceType } from '../../theme';

export function PersistentSessionCardOverlay({ api, cardId, sessionId, bottomSafeAreaInset, onClose }: {
  api: ApiClient | null;
  cardId: string | null;
  sessionId: string | undefined;
  bottomSafeAreaInset: number;
  onClose(): void;
}) {
  const phone = useDeviceType() === 'phone';
  const { width } = useWindowDimensions();
  const overlayWidth = getFolderWorkspaceOverlayWidth(width);
  const frameWidth = overlayWidth + StyleSheet.hairlineWidth * 2;
  const detailWidth = getCardDetailPaneWidth(overlayWidth);
  const [renderedCardId, setRenderedCardId] = useState(cardId);
  const [closedChatCardId, setClosedChatCardId] = useState<string | null>(null);
  const [sessionChoice, setSessionChoice] = useState<{ cardId: string; sessionId: string } | null>(null);
  const wasVisible = useRef(cardId !== null);
  const detail = useCardStore(state => renderedCardId ? state.details[renderedCardId] : undefined);
  const assignedSessionId = detail?.card.assigneeKind === 'session' ? detail.card.assigneeSessionId : null;
  const selectedSessionId = sessionChoice?.cardId === renderedCardId ? sessionChoice.sessionId : assignedSessionId;
  const sameSession = Boolean(sessionId && selectedSessionId === sessionId);
  const chatSessionId = closedChatCardId === renderedCardId ? null : selectedSessionId;

  useEffect(() => {
    if (cardId) {
      if (!wasVisible.current || renderedCardId !== cardId) {
        setClosedChatCardId(null);
        setSessionChoice(null);
      }
      setRenderedCardId(cardId);
    }
    wasVisible.current = cardId !== null;
  }, [cardId, renderedCardId]);

  const onHidden = useCallback(() => {
    if (cardId === null) setRenderedCardId(null);
  }, [cardId]);
  const closeChat = useCallback(() => {
    if (renderedCardId) setClosedChatCardId(renderedCardId);
  }, [renderedCardId]);
  const openSessionInOverlay = useCallback((nextSessionId: string) => {
    if (!renderedCardId) return;
    setSessionChoice({ cardId: renderedCardId, sessionId: nextSessionId });
    setClosedChatCardId(null);
  }, [renderedCardId]);

  if (!renderedCardId || phone) return null;
  return <CardPanelOverlayFrame visible={cardId !== null} width={frameWidth} onClose={onClose}
    onHidden={onHidden} testID="persistent-card-overlay" direction="row"
    chatPaneMinimumBottomPadding={bottomSafeAreaInset}>
    <CardDetailChatPanes api={api} cardId={renderedCardId} active detailWidth={detailWidth}
      onClose={onClose} onOpenSession={openSessionInOverlay} sessionId={chatSessionId} onCloseChat={closeChat}
      ownsSessionConnection={!sameSession} />
  </CardPanelOverlayFrame>;
}
