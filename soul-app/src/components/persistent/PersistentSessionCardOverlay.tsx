import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import type { ApiClient } from '../../api/client';
import { CardDetailContent } from '../planner/CardDetailSheet';
import { CardDetailChatPanes, CardPanelOverlayFrame } from '../planner/FolderWorkspaceReadOverlay';
import { ChatPane } from '../split/ChatPane';
import { SettingsSegmentedControl } from '../settings/SettingsSegmentedControl';
import { useCardStore } from '../../store/cardStore';
import { getCardDetailPaneWidth, getFolderWorkspaceOverlayWidth } from '../../lib/folder-workspace-layout';
import { useDeviceType, useTokens } from '../../theme';

type PhoneSection = 'card' | 'conversation';

export function PersistentSessionCardOverlay({ api, cardId, sessionId, onClose }: {
  api: ApiClient | null;
  cardId: string | null;
  sessionId: string | undefined;
  onClose(): void;
}) {
  const device = useDeviceType();
  const phone = device === 'phone';
  const t = useTokens();
  const { width } = useWindowDimensions();
  const overlayWidth = getFolderWorkspaceOverlayWidth(width);
  const frameWidth = overlayWidth + StyleSheet.hairlineWidth * 2;
  const detailWidth = getCardDetailPaneWidth(overlayWidth);
  const [renderedCardId, setRenderedCardId] = useState(cardId);
  const [closedChatCardId, setClosedChatCardId] = useState<string | null>(null);
  const [sessionChoice, setSessionChoice] = useState<{ cardId: string; sessionId: string } | null>(null);
  const [phoneSection, setPhoneSection] = useState<{ cardId: string; value: PhoneSection } | null>(null);
  const wasVisible = useRef(cardId !== null);
  const detail = useCardStore(state => renderedCardId ? state.details[renderedCardId] : undefined);
  const assignedSessionId = detail?.card.assigneeKind === 'session' ? detail.card.assigneeSessionId : null;
  const selectedSessionId = sessionChoice?.cardId === renderedCardId ? sessionChoice.sessionId : assignedSessionId;
  const sameSession = Boolean(sessionId && selectedSessionId === sessionId);
  const chatSessionId = closedChatCardId === renderedCardId ? null : selectedSessionId;
  const section = phoneSection?.cardId === renderedCardId ? phoneSection.value : 'card';

  useEffect(() => {
    if (cardId) {
      if (!wasVisible.current || renderedCardId !== cardId) {
        setClosedChatCardId(null);
        setSessionChoice(null);
        setPhoneSection(null);
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
    if (phone) setPhoneSection({ cardId: renderedCardId, value: 'conversation' });
  }, [phone, renderedCardId]);

  if (!renderedCardId) return null;
  return <CardPanelOverlayFrame visible={cardId !== null} width={frameWidth} onClose={onClose}
    onHidden={onHidden} testID="persistent-card-overlay" direction={phone ? 'column' : 'row'}>
    {phone ? <>
      <View style={{ paddingHorizontal: t.foundation.pageInset, paddingVertical: t.uiSpacing.sm }}>
        <SettingsSegmentedControl<PhoneSection> id="persistent-card-overlay" variant="detail" value={section}
          onChange={value => setPhoneSection({ cardId: renderedCardId, value })}
          options={[{ value: 'card', label: '카드' }, { value: 'conversation', label: '대화' }]} />
      </View>
      <View style={{ flex: 1, minHeight: 0 }}>
        <View testID="persistent-card-overlay-card-content" pointerEvents={section === 'card' ? 'auto' : 'none'}
          accessibilityElementsHidden={section !== 'card'} importantForAccessibility={section !== 'card' ? 'no-hide-descendants' : 'auto'}
          style={{ flex: 1, display: section === 'card' ? 'flex' : 'none' }}>
          <CardDetailContent key={renderedCardId} api={api} cardId={renderedCardId} inline onClose={onClose} onOpenSession={openSessionInOverlay} />
        </View>
        <View testID="persistent-card-overlay-conversation-content" pointerEvents={section === 'conversation' ? 'auto' : 'none'}
          accessibilityElementsHidden={section !== 'conversation'} importantForAccessibility={section !== 'conversation' ? 'no-hide-descendants' : 'auto'}
          style={{ flex: 1, display: section === 'conversation' ? 'flex' : 'none' }}>
          {sameSession ? null : <ChatPane active={section === 'conversation'} sessionId={chatSessionId} onClose={closeChat} />}
        </View>
      </View>
    </> : <CardDetailChatPanes api={api} cardId={renderedCardId} active detailWidth={detailWidth}
      onClose={onClose} onOpenSession={openSessionInOverlay} sessionId={chatSessionId} onCloseChat={closeChat} hideChat={sameSession} />}
  </CardPanelOverlayFrame>;
}
