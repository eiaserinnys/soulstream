import React, { useMemo, useState } from 'react';
import { Platform, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Asset } from 'expo-asset';
import type { ApiClient } from '../api/client';
import type { CardAttachmentAssetEvidence, CardCheckItem, CardComment, CardDetail, CardStatus } from '../api/cardTypes';
import type { PersistentReportEntry } from '../api/types';
import { cardFixture } from '../test-support/cards';
import { useDeviceType, useTokens } from '../theme';
import { ContentLinkProvider } from '../navigation/ContentLinkProvider';
import { ChatUiControllerProvider } from '../components/chat-ui/ChatUiControllerProvider';
import { PersistentReportPager } from '../components/persistent/PersistentReportPager';
import { PersistentReportCardExpansion } from '../components/persistent/PersistentReportCardExpansion';
import { PersistentReportCardSheetHeader } from '../components/persistent/PersistentReportCardSheetHeader';
import { PersistentReportCardSheetComplete } from '../components/persistent/PersistentReportCardSheetComplete';
import { usePersistentCardCompletion } from '../components/persistent/usePersistentCardCompletion';
import { ReportComposerFocusContext, useReportComposerScroll } from '../components/persistent/useReportComposerScroll';
import { minimumReportBubbleHeight } from '../components/persistent/persistentReportStyles';
import { calculatePersistentSessionLayout } from '../../../packages/soul-ui/src/lib/persistent-session-layout';
import { PERSISTENT_SESSION_FRAME as FRAME } from '../components/persistent/persistentSessionFrame';
import { SwayCharacter } from '../components/persistent/SwayCharacter';
import { CardStatusChip } from '../components/planner/CardRow';
import { cardDetailStyles } from '../components/planner/CardDetail.styles';
import { AppModalSurface } from '../components/AppModalSurface';
import { UserMessage } from '../components/events/UserMessage';
import { AssistantMessage } from '../components/events/AssistantMessage';
import { ChatComposer } from '../components/chat/ChatComposer';
import { persistentReportStatusCard } from '../lib/persistent-report-card';

const at = '2026-10-05T08:00:00Z';
const card = cardFixture({ id: 'preview-pas-card', number: 531, status: 'review',
  title: 'PAS 판에서 결과와 증거를 확인하고 담당에게 커멘트까지 남기는 화면',
  now: { text: '웹과 앱의 제자리 펼침 시안을 준비했습니다.', turn: 'user', ask: '화면과 증거를 확인해 주세요.', updatedAt: at, sessionId: 'preview-agent' },
});
const secondCard = cardFixture({ id: 'preview-pas-card-2', number: 532, status: 'review', title: '두 번째 검수 카드 장',
  now: { text: '연속 완료와 되돌리기를 확인할 두 번째 카드입니다.', turn: 'user', ask: '두 번째 카드도 확인해 주세요.', updatedAt: at, sessionId: 'preview-agent' },
});
const image = (module: number) => new URL(Asset.fromModule(module).uri, window.location.origin).href;
function previewEvidence(module: number, label: string): CardAttachmentAssetEvidence {
  const url = image(module);
  return { type: 'image', url, label, attachment_id: label,
    descriptor: { attachment_id: label, name: label + '.png', mime_type: 'image/png', byte_size: 1593049,
      checksum_sha256: null, width: 64, height: 64, preview_kind: 'image', preview_mime_type: 'image/png' },
    read_context: { type: 'card', id: card.id }, previewUrl: url, originalUrl: url };
}
function createPreviewItems(): CardCheckItem[] {
  return [
    { id: 1, title: '판 안에서 결과와 증거를 읽습니다', state: 'done', result: '제목을 누르면 같은 자리에서 펼쳐집니다.',
      evidence: [previewEvidence(require('../../assets/icon.png'), '펼친 화면')], caveat: null, rev: 1, confirmed: null, fixOpen: 0, reopened: null, from: null, createdAt: at, reportedAt: at, display: 'reported' },
    { id: 2, title: '담당에게 바로 커멘트를 남깁니다', state: 'done', result: 'PAS 대화를 떠나지 않고 글을 보냅니다.',
      evidence: [previewEvidence(require('../../assets/icon-symbol.png'), '입력 화면')], caveat: null, rev: 1, confirmed: null, fixOpen: 0, reopened: null, from: null, createdAt: at, reportedAt: at, display: 'reported' },
    { id: 3, title: '실기기 화면 확인', state: 'todo', result: null, evidence: [], caveat: 'iPhone 실기기에서는 아직 확인하지 못했습니다.', rev: 1, confirmed: null, fixOpen: 0, reopened: null, from: null, createdAt: at, reportedAt: null, display: 'todo' },
  ];
}
const initialEntries: (PersistentReportEntry & { card_id: string; card_status: string })[] = [
  { key: 'card_preview', kind: 'see', title: card.title.slice(0, 24) + '…', context: card.now!.ask!, action: '', options: [], state: 'open', answer: '', card_numbers: [531], card_id: card.id, card_status: 'review', updated_at: at },
  { key: 'card_preview_2', kind: 'see', title: secondCard.title.slice(0, 24) + '…', context: secondCard.now!.ask!, action: '', options: [], state: 'open', answer: '', card_numbers: [532], card_id: secondCard.id, card_status: 'review', updated_at: at },
  { key: 'cq_preview', question_id: 'preview-question', kind: 'ask', title: '입력 위치 확인', context: '추가 커멘트를 장 안에서 바로 쓸까요?', action: '', options: ['장 안에서', '카드에서'], state: 'open', answer: '', card_numbers: [531], card_id: card.id, card_status: 'blocked', updated_at: at },
  { key: 'card_blocked_preview', kind: 'see', title: '외부 권한 확인', context: '외부 권한 확인이 필요해 작업이 멈췄습니다.', action: '', options: [], state: 'open', answer: '', card_numbers: [531], card_id: card.id, card_status: 'blocked', updated_at: at },
];
const noop = () => {};
function reviewEntries() {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('singleCard') === '1'
    ? [initialEntries[0]] : initialEntries;
}
const question = { id: 'preview-question', cardId: card.id, sessionId: 'preview-agent', text: '추가 커멘트를 장 안에서 바로 쓸까요?',
  options: ['장 안에서', '카드에서'], answer: null, askedAt: at };
export function createReviewCardApi(onStatusChange: (id: string, status: CardStatus) => void = () => {}): ApiClient {
  const items = createPreviewItems();
  let details: Record<string, CardDetail> = {
    [card.id]: { card: { ...card, items }, reports: [], questions: [question], sessions: [], nowHistory: [], comments: [
      { id: 'preview-user', cardId: card.id, authorKind: 'user', authorId: null, sessionId: null, kind: 'comment', body: 'PAS 안에서 결과를 읽고 의견도 남기고 싶어요.', createdAt: at },
      { id: 'preview-agent', cardId: card.id, authorKind: 'agent', authorId: null, sessionId: null, kind: 'comment', body: '결과와 증거를 장 안에 모았습니다.', createdAt: '2026-10-05T08:01:00Z' },
    ] },
    [secondCard.id]: { card: { ...secondCard }, reports: [], questions: [], sessions: [], nowHistory: [], comments: [] },
  };
  const snapshot = (detail: CardDetail): CardDetail => ({ ...detail, card: { ...detail.card, items: [...(detail.card.items ?? [])] },
    questions: [...detail.questions], comments: [...(detail.comments ?? [])] });
  const api: Pick<ApiClient, 'listCards' | 'getCard' | 'setCardStatus' | 'confirmCardItem' | 'addCardComment' | 'answerCardQuestion'> = {
    listCards: async () => ({ cards: Object.values(details).map(detail => detail.card) }),
    getCard: async id => {
      const detail = details[id];
      if (!detail) throw new Error('공개 예시: 없는 카드입니다.');
      return snapshot(detail);
    },
    setCardStatus: async (id, status, expectedVersion) => {
      const detail = details[id];
      if (!detail || expectedVersion !== detail.card.version) throw new Error('공개 예시: 카드가 바뀌었습니다.');
      const next = { ...detail, card: { ...detail.card, status, version: detail.card.version + 1 } };
      details = { ...details, [id]: next };
      onStatusChange(id, status);
      return { folderId: next.card.folderId, card: next.card };
    },
    confirmCardItem: async (_cardId, itemId, confirmed) => {
      const detail = details[card.id];
      const nextItems = (detail.card.items ?? []).map(item => item.id !== itemId ? item : { ...item,
        confirmed: confirmed ? { at, rev: item.rev } : null,
        display: confirmed ? 'confirmed' as const : item.state === 'done' ? 'reported' as const : 'todo' as const });
      const next = { ...detail, card: { ...detail.card, items: nextItems } };
      details = { ...details, [card.id]: next };
      return { folderId: next.card.folderId, card: next.card };
    },
    addCardComment: async (cardId, input) => {
      const detail = details[cardId] ?? details[card.id];
      const comment: CardComment = { id: input.idempotencyKey, cardId: detail.card.id, authorKind: 'user', authorId: null, sessionId: null,
        kind: 'comment', ...(input.itemId === undefined ? {} : { itemId: input.itemId }), body: input.body, createdAt: new Date().toISOString() };
      const next = { ...detail, comments: [...(detail.comments ?? []), comment] };
      details = { ...details, [detail.card.id]: next };
      return comment;
    },
    answerCardQuestion: async (_cardId, questionId, answer) => {
      const detail = details[card.id];
      const next = { ...detail, questions: detail.questions.map(item => item.id === questionId ? { ...item, answer, answeredAt: new Date().toISOString() } : item) };
      details = { ...details, [card.id]: next };
      return { folderId: next.card.folderId, card: next.card };
    },
  };
  return api as unknown as ApiClient;
}


/** Proposal only: same app parts and geometry, with local fixtures instead of stores/HTTP. */
export function ReviewPasCardExpand() {
  const t = useTokens();
  const phone = useDeviceType() === 'phone';
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [entries, setEntries] = useState<PersistentReportEntry[]>(reviewEntries);
  const [index, setIndex] = useState(0);
  const [sheet, setSheet] = useState<PersistentReportEntry | null>(null);
  const sheetScroll = useReportComposerScroll();
  const [text, setText] = useState('');
  const api = useMemo(() => createReviewCardApi((id, status) => {
    const reviewEntry = initialEntries.find(entry => entry.card_id === id);
    if (!reviewEntry) return;
    setEntries(saved => {
      if (status === 'done') return saved.filter(entry => entry.key !== reviewEntry.key);
      return saved.some(entry => entry.key === reviewEntry.key) ? saved : [reviewEntry, ...saved];
    });
  }), []);
  const completion = usePersistentCardCompletion(api);
  const styles = useMemo(() => cardDetailStyles(t), [t]);
  const column = phone ? width - t.foundation.pageInset * 2 : FRAME.landscape.conversation;
  const left = (width - column) / 2;
  const layout = calculatePersistentSessionLayout({ app: { left: 0, top: 0, width, height },
    header: { left: 0, top: 0, width, height: FRAME.header + insets.top },
    main: { left, top: FRAME.header + insets.top, width: column, height: height - FRAME.header - insets.top },
    baselineBottom: height - insets.bottom - t.uiSpacing.lg, inputRowHeight: t.hitTarget.min,
    rowBottomGap: t.spacing.xs, pointerFine: false, showCharacter: true, phoneConfigured: phone,
    reportBubble: { widthScale: 1, minimumHeight: minimumReportBubbleHeight(t) } });
  const answer = (entry: PersistentReportEntry, body: string) => {
    setEntries(saved => saved.map(item => item.key === entry.key ? { ...item, state: 'answered', answer: body, updated_at: 'preview-answer' } : item));
    setSheet(null);
  };
  const details = (entry: PersistentReportEntry) => <PersistentReportCardExpansion key={entry.key} api={api} entry={entry} />;
  const pager = <PersistentReportPager entries={entries} index={Math.min(index, Math.max(0, entries.length - 1))} api={api} sessionId="preview-pas" completion={completion}
    onSelect={setIndex} onDismiss={async key => { setEntries(saved => saved.filter(item => item.key !== key)); }} onFocusComposer={noop}
    bubble={Boolean(layout.reportBubble)} maxHeight={layout.reportBubble?.maxHeight ?? layout.reportViewMaxHeight}
    renderCardStatus={entry => { const statusCard = persistentReportStatusCard(entry); return statusCard ? <CardStatusChip card={statusCard} detail /> : null; }}
    renderCardDetails={phone ? undefined : details} onOpenCardDetails={phone ? setSheet : undefined}
    send={{ busy: false, close: () => true, canCancel: () => false, cancelSent: () => false, sendOption: async (entry: PersistentReportEntry, option: string) => answer(entry, option) } as any} />;
  return <ContentLinkProvider><ChatUiControllerProvider sessionId="preview-pas" appendGeneratedText={() => ({ ok: true })}>
    <View testID="pas-card-expand-review" style={{ flex: 1, backgroundColor: t.persistentSession.paper, paddingTop: insets.top, paddingBottom: insets.bottom }}>
      <View style={styles.header}><Text style={styles.heading}>PAS · 카드 펼침 시안</Text></View>
      <View style={{ flex: 1, minHeight: 0, width: column, alignSelf: 'center', gap: t.uiSpacing.lg }}>
        <UserMessage event={{ id: 'preview-user', type: 'user_message', data: { text: 'PAS 안에서 결과를 보고 의견도 남기고 싶어요.' } }} />
        <AssistantMessage event={{ id: 'preview-agent', type: 'assistant_message', data: { text: '시안을 준비했습니다. 장을 눌러 확인해 주세요.' } }} />
        {phone || !layout.reportBubble ? pager : null}
      </View>
      <View style={{ width: column, alignSelf: 'center' }}><ChatComposer input={text} onChangeInput={setText} onSend={() => setText('')} onPickAttachment={noop}
        uploading={false} sending={false} voiceControls={null} presentation="manuscript" /></View>
      {layout.body ? <View pointerEvents="none" style={{ position: 'absolute', left: layout.body.left, top: layout.body.top, width: layout.body.width, height: layout.body.height }}>
        <SwayCharacter width={layout.body.width} height={layout.body.height} shown motionEnabled={false} active={false} />
      </View> : null}
      {layout.reportBubble ? <View style={{ position: 'absolute', left: layout.reportBubble.left, bottom: height - layout.reportBubble.bottom, width: layout.reportBubble.width }}>{pager}</View> : null}
    </View>
    {sheet ? <AppModalSurface visible modalId="modal_card_detail" variant="expanded" presentationStyle="pageSheet" onRequestClose={() => setSheet(null)} surfaceTestID="pas-card-preview-sheet">
      <PersistentReportCardSheetHeader entry={sheet} onCollapse={() => setSheet(null)} />
      <ScrollView style={{ flex: 1, minHeight: 0 }} ref={sheetScroll.scroll} contentContainerStyle={{ padding: t.foundation.pageInset }} showsVerticalScrollIndicator={false}
        onLayout={sheetScroll.keepComposerVisible} onContentSizeChange={sheetScroll.keepComposerVisible}
        keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive"
        automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}>
        <ReportComposerFocusContext.Provider value={sheetScroll.onFocusChange}>
          {details(sheet)}
          <PersistentReportCardSheetComplete entry={sheet} completion={completion} onCompleted={() => setSheet(null)} />
        </ReportComposerFocusContext.Provider>
      </ScrollView>
    </AppModalSurface> : null}
  </ChatUiControllerProvider></ContentLinkProvider>;
}
