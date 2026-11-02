import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, useWindowDimensions } from 'react-native';
import type { ApiClient } from '../../api/client';
import { CardDetailChatPanes, CardPanelOverlayFrame, DuoTopBandRailScope, FolderWorkspaceSinglePanel } from '../planner/FolderWorkspaceReadOverlay';
import { useCardStore } from '../../store/cardStore';
import { getCardDetailPaneWidth, getFolderWorkspaceOverlayWidth, shouldUseSinglePanel } from '../../lib/folder-workspace-layout';
import { useDeviceType } from '../../theme';
import { DUO_SIDE_BAND_WIDTH } from '../../navigation/duoSideBand';

export function PersistentSessionCardOverlay({ api, cardId, sessionId, bottomSafeAreaInset, sheetTop, railBand = false, onClose }: {
  api: ApiClient | null;
  cardId: string | null;
  sessionId: string | undefined;
  bottomSafeAreaInset: number;
  sheetTop?: number;
  railBand?: boolean;
  onClose(): void;
}) {
  const phone = useDeviceType() === 'phone';
  const { width } = useWindowDimensions();
  const overlayWidth = getFolderWorkspaceOverlayWidth(width);
  const frameWidth = overlayWidth + StyleSheet.hairlineWidth * 2;
  const singlePanel = shouldUseSinglePanel(overlayWidth);
  const sheetRight = railBand ? DUO_SIDE_BAND_WIDTH : 0;
  const sheetWidth = railBand ? width - DUO_SIDE_BAND_WIDTH : frameWidth;
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
  return <CardPanelOverlayFrame visible={cardId !== null} width={sheetWidth} sheetRight={sheetRight} onClose={onClose}
    onHidden={onHidden} testID="persistent-card-overlay"
    chatPaneMinimumBottomPadding={bottomSafeAreaInset} sheetTop={sheetTop} direction={singlePanel ? 'column' : 'row'}>
    {singlePanel ? <DuoTopBandRailScope enabled={railBand}>
      <FolderWorkspaceSinglePanel api={api} cardId={renderedCardId} pageId={null} sessionId={selectedSessionId}
        active={cardId !== null} onClose={onClose} onOpenSession={openSessionInOverlay}
        ownsSessionConnection={!sameSession} />
    </DuoTopBandRailScope> : <CardDetailChatPanes api={api} cardId={renderedCardId} active={cardId !== null} detailWidth={detailWidth}
      onClose={onClose} onOpenSession={openSessionInOverlay} sessionId={chatSessionId} onCloseChat={closeChat}
      ownsSessionConnection={!sameSession} />}
  </CardPanelOverlayFrame>;
}
