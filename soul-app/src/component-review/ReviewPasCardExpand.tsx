import React, { useMemo, useRef, useState } from 'react';
import { ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Asset } from 'expo-asset';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ApiClient } from '../api/client';
import type { CardAttachmentAssetEvidence, CardCheckItem, CardDetail } from '../api/cardTypes';
import type { PersistentReportEntry } from '../api/types';
import { cardFixture } from '../test-support/cards';
import { useDeviceType, useTokens } from '../theme';
import { ContentLinkProvider } from '../navigation/ContentLinkProvider';
import { ChatUiControllerProvider } from '../components/chat-ui/ChatUiControllerProvider';
import { PersistentReportPager } from '../components/persistent/PersistentReportPager';
import { minimumReportBubbleHeight } from '../components/persistent/persistentReportStyles';
import { calculatePersistentSessionLayout } from '../../../packages/soul-ui/src/lib/persistent-session-layout';
import { PERSISTENT_SESSION_FRAME as FRAME } from '../components/persistent/persistentSessionFrame';
import { SwayCharacter } from '../components/persistent/SwayCharacter';
import { CardNowPanel } from '../components/planner/CardNowPanel';
import { CardCheckItems } from '../components/planner/CardCheckItems';
import { CardTimeline } from '../components/planner/CardTimeline';
import { CardCommentComposer, type CardCommentComposerHandle } from '../components/planner/CardCommentComposer';
import { CardStatusChip } from '../components/planner/CardRow';
import { cardDetailStyles } from '../components/planner/CardDetail.styles';
import { GlassButton } from '../components/GlassSurface';
import { AppModalSurface } from '../components/AppModalSurface';
import { UserMessage } from '../components/events/UserMessage';
import { AssistantMessage } from '../components/events/AssistantMessage';
import { ChatComposer } from '../components/chat/ChatComposer';

const at = '2026-10-05T08:00:00Z';
const card = cardFixture({ id: 'preview-pas-card', number: 531, status: 'review',
  title: 'PAS 판에서 결과와 증거를 확인하고 담당에게 커멘트까지 남기는 화면',
  now: { text: '웹과 앱의 제자리 펼침 시안을 준비했습니다.', turn: 'user', ask: '화면과 증거를 확인해 주세요.', updatedAt: at, sessionId: 'preview-agent' },
});
const image = (module: number) => new URL(Asset.fromModule(module).uri, window.location.origin).href;
function previewEvidence(module: number, label: string): CardAttachmentAssetEvidence {
  const url = image(module);
  return { type: 'image', url, label, attachment_id: label,
    descriptor: { attachment_id: label, name: label + '.png', mime_type: 'image/png', byte_size: 1593049,
      checksum_sha256: null, width: 64, height: 64, preview_kind: 'image', preview_mime_type: 'image/png' },
    read_context: { type: 'card', id: card.id }, previewUrl: url, originalUrl: url };
}
const items: CardCheckItem[] = [
  { id: 1, title: '판 안에서 결과와 증거를 읽습니다', state: 'done', result: '제목을 누르면 같은 자리에서 펼쳐집니다.',
    evidence: [previewEvidence(require('../../assets/icon.png'), '펼친 화면')], caveat: null, rev: 1, confirmed: null, fixOpen: 0, reopened: null, from: null, createdAt: at, reportedAt: at, display: 'reported' },
  { id: 2, title: '담당에게 바로 커멘트를 남깁니다', state: 'done', result: 'PAS 대화를 떠나지 않고 글을 보냅니다.',
    evidence: [previewEvidence(require('../../assets/icon-symbol.png'), '입력 화면')], caveat: null, rev: 1, confirmed: null, fixOpen: 0, reopened: null, from: null, createdAt: at, reportedAt: at, display: 'reported' },
  { id: 3, title: '실기기 화면 확인', state: 'todo', result: null, evidence: [], caveat: 'iPhone 실기기에서는 아직 확인하지 못했습니다.', rev: 1, confirmed: null, fixOpen: 0, reopened: null, from: null, createdAt: at, reportedAt: null, display: 'todo' },
];
const initialEntries: (PersistentReportEntry & { card_id: string; card_status: string })[] = [
  { key: 'card_preview', kind: 'see', title: card.title.slice(0, 24) + '…', context: card.now!.ask!, action: '', options: [], state: 'open', answer: '', card_numbers: [531], card_id: card.id, card_status: 'review', updated_at: at },
  { key: 'cq_preview', question_id: 'preview-question', kind: 'ask', title: '입력 위치 확인', context: '추가 커멘트를 장 안에서 바로 쓸까요?', action: '', options: ['장 안에서', '카드에서'], state: 'open', answer: '', card_numbers: [531], card_id: card.id, card_status: 'blocked', updated_at: at },
];
const noop = () => {};


/** Proposal only: same app parts and geometry, with local fixtures instead of stores/HTTP. */
export function ReviewPasCardExpand() {
  const t = useTokens();
  const phone = useDeviceType() === 'phone';
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [entries, setEntries] = useState<PersistentReportEntry[]>(initialEntries);
  const [index, setIndex] = useState(0);
  const [sheet, setSheet] = useState<PersistentReportEntry | null>(null);
  const [text, setText] = useState('');
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
  const details = (entry: PersistentReportEntry) => <PreviewContents key={entry.key} entry={entry} onAnswer={body => answer(entry, body)} />;
  const pager = <PersistentReportPager entries={entries} index={Math.min(index, entries.length - 1)} api={null} sessionId="preview-pas"
    onSelect={setIndex} onDismiss={async key => { setEntries(saved => saved.filter(item => item.key !== key)); }} onFocusComposer={noop}
    bubble={Boolean(layout.reportBubble)} maxHeight={layout.reportBubble?.maxHeight}
    renderCardStatus={entry => <CardStatusChip card={{ ...card, status: entry.key.startsWith('cq_') ? 'blocked' : 'review', blockedKind: entry.key.startsWith('cq_') ? 'question' : null }} detail />}
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
      <View style={styles.header}><View style={styles.headerRow}>
        <GlassButton iconOnly size="compact" accessibilityLabel="닫기" onPress={() => setSheet(null)}><Ionicons name="close" size={t.iconSize.standard} color={t.colors.textPrimary} /></GlassButton>
        <Text style={styles.heading} numberOfLines={2}><CardStatusChip card={card} detail /> {sheet.title}</Text>
      </View></View>
      <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: t.foundation.pageInset }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">{details(sheet)}</ScrollView>
    </AppModalSurface> : null}
  </ChatUiControllerProvider></ContentLinkProvider>;
}

function PreviewContents({ entry, onAnswer }: { entry: PersistentReportEntry; onAnswer(body: string): void }) {
  const t = useTokens();
  const { width } = useWindowDimensions();
  const composer = useRef<CardCommentComposerHandle>(null);
  const [rows, setRows] = useState(items);
  const [comments, setComments] = useState<CardDetail['comments']>([
    { id: 'preview-user', cardId: card.id, authorKind: 'user', authorId: null, sessionId: null, kind: 'comment', body: 'PAS 안에서 결과를 읽고 의견도 남기고 싶어요.', createdAt: at },
    { id: 'preview-agent', cardId: card.id, authorKind: 'agent', authorId: null, sessionId: null, kind: 'comment', body: '결과와 증거를 장 안에 모았습니다.', createdAt: '2026-10-05T08:01:00Z' },
  ]);
  const question = entry.key.startsWith('cq_') ? { id: 'preview-question', cardId: card.id, sessionId: 'preview-agent', text: entry.context, options: entry.options, answer: null, askedAt: at } : undefined;
  const api = { answerCardQuestion: async (_card: string, _question: string, body: string) => { onAnswer(body); return {}; } } as unknown as ApiClient;
  const detail: CardDetail = { card: { ...card, items: rows }, sessions: [], reports: [], questions: [], comments: comments?.slice(-2) };
  return <View testID="pas-card-preview" style={{ gap: t.uiSpacing.lg }}>
    <CardNowPanel now={card.now!} history={[]} />
    <CardCheckItems cardId={card.id} items={rows} paneWidth={width} pendingConfirmations={{}} initiallyConfirmedIds={[]} newlyConfirmedIds={[]}
      onConfirm={async (id, checked) => { setRows(saved => saved.map(item => item.id === id ? { ...item, display: checked ? 'confirmed' : 'reported' } : item)); return true; }}
      onSetTarget={() => composer.current?.focus()} onRecentConfirmation={noop} />
    <CardTimeline detail={detail} onChooseAnswer={noop} commentsOnly />
    <GlassButton variant="plain" size="compact" accessibilityLabel="카드 열기" onPress={noop}><Text style={{ ...t.foundation.typography.body, color: t.colors.link }}>카드 열기</Text></GlassButton>
    <CardCommentComposer ref={composer} api={api} cardId={entry.key} cardLoaded locked={false} sending={false} onBusyChange={noop} embedded question={question}
      placeholder={question ? '질문에 답하기' : '커멘트'}
      runMutation={async (mutation, accepted) => { await mutation(); accepted?.(); return true; }} onSent={noop}
      sendComment={async (body, accepted) => { setComments(saved => [...(saved ?? []), { id: String(Date.now()), cardId: card.id, authorKind: 'user', authorId: null, sessionId: null, kind: 'comment', body, createdAt: new Date().toISOString() }]); accepted?.(); return true; }} />
  </View>;
}
