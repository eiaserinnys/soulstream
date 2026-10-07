import React, { useEffect, useMemo, useState } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { SessionEvent } from '../api/types';
import { CardRow } from '../components/planner/CardRow';
import { PersistentSessionCardOverlay } from '../components/persistent/PersistentSessionCardOverlay';
import { ChatBody } from '../components/chat/ChatBody';
import { createPersistentReviewApi, persistentReviewCards } from './persistent-review-fixtures';
import { useChatStore } from '../store/chatStore';
import { useSettingsStore } from '../store/settingsStore';
import { useDeviceType, useTokens } from '../theme';

const pasSessionId = 'review-pas-1';
const pasEvents: SessionEvent[] = [
  { id: '710', type: 'user_message', data: { input_id: 'review-pas-user', text: '카드 패널을 열어도 이 대화의 위치와 입력을 유지합니다.' } },
  { id: '711', type: 'assistant_message', data: { text: '이 대화는 배경에서 계속 유지됩니다.' } },
];

export function ReviewPersistentCardOverlay() {
  const t = useTokens();
  const insets = useSafeAreaInsets();
  const phone = useDeviceType() === 'phone';
  const { width } = useWindowDimensions();
  const query = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const scenario = query.get('case') ?? 'assigned';
  const sourceCard = scenario === 'unassigned' ? persistentReviewCards.summaryCard : persistentReviewCards.sessionNamedCard;
  const assignedSessionId = scenario === 'self' ? pasSessionId : scenario === 'assigned' ? 'review-pas-2' : null;
  const card = assignedSessionId ? { ...sourceCard, assigneeKind: 'session' as const, assigneeSessionId: assignedSessionId }
    : sourceCard;
  const api = useMemo(() => {
    const base = createPersistentReviewApi(null);
    if (!assignedSessionId) return base;
    return { ...base, getCard: async (id: string) => {
      const detail = await base.getCard(id);
      return { ...detail, card: { ...detail.card, assigneeKind: 'session' as const, assigneeSessionId: assignedSessionId, assigneeAgentId: null } };
    } };
  }, [assignedSessionId]);
  const [selected, setSelected] = useState<string | null>(() => query.get('open') === '1' ? card.id : null);
  useEffect(() => {
    const store = useChatStore.getState();
    store.mergeEvents(pasSessionId, pasEvents);
    const pasRequest = store.beginPersistentDisplaySettingsLoad(pasSessionId);
    store.finishPersistentDisplaySettingsLoad(pasSessionId, pasRequest, {
      show_generation_separator: true, show_jev_candidates: true, show_character: true,
      animate_character: true, show_turn_usage: true,
    });
    if (scenario === 'assigned' && assignedSessionId) {
      store.mergeEvents(assignedSessionId, pasEvents.map(event => ({ ...event, id: `assigned-${event.id}` })));
    }
  }, [assignedSessionId, scenario]);
  useEffect(() => {
    if (query.get('open') === '1') setSelected(card.id);
  }, [card.id]);

  return <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: t.persistentSession.paper }}>
    <View testID="review-persistent-card-overlay" style={{ flex: 1 }}>
      <View testID="review-persistent-background-chat" style={{ flex: 1 }}>
        <ChatBody sessionId={pasSessionId} presentation="manuscript" minimumBottomPadding={phone ? 0 : insets.bottom} />
      </View>
      <View style={{ position: 'absolute', top: t.foundation.pageInset, left: t.foundation.pageInset,
        width: Math.min(t.tabletShell.folderPane.maxWidth, Math.max(0, width - t.foundation.pageInset * 2)) }}>
        <CardRow api={api} card={card} variant="summary" onOpen={() => setSelected(card.id)} />
      </View>
      <PersistentSessionCardOverlay api={api} cardId={selected} sessionId={pasSessionId} onClose={() => setSelected(null)} />
    </View>
  </SafeAreaView>;
}
