// 카드 #1197: 질문 장 「결정 한 장」의 앱 검수 표본. 운영과 같은 부품, 폭, 상태로
// PAS 판(PersistentReportPager + PersistentReportCardExpansion)과 카드 상세(CardDetailContent)를 그린다.
// 화면 계약 4절의 새 구성(질문 장 부품, 동그라미 없는 선택지 묶음, 대상 줄, 글타래와 기다림 행, 칩 글)을
// ?scene으로, 표면을 ?surface로 고른다.
//   ?section=cardQuestion&surface=pas|card&scene=ga|na|da|ra|ma|ba&expanded=1&fail=1&theme=light|dark
//   ga 새 선택 질문(그림, 권함) · na 되묻기 뒤 기다림 · da 선택 답 뒤 덧붙이기 대상
//   ra 부탁 장 · ma 옛 질문 · ba 고친 질문
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Asset } from 'expo-asset';
import type { ApiClient } from '../api/client';
import type { CardCheckItem, CardComment, CardDetail, CardQuestion, CardStatus } from '../api/cardTypes';
import type { CardQuestionOption } from '../../../packages/wire-schema/src/card_questions';
import type { MessageContextItem, PersistentReportEntry, Session } from '../api/types';
import { cardFixture } from '../test-support/cards';
import { useDeviceType, useTokens } from '../theme';
import { ContentLinkProvider } from '../navigation/ContentLinkProvider';
import { ChatUiControllerProvider } from '../components/chat-ui/ChatUiControllerProvider';
import { PersistentReportPager } from '../components/persistent/PersistentReportPager';
import { PersistentReportCardExpansion } from '../components/persistent/PersistentReportCardExpansion';
import { usePersistentReport } from '../components/persistent/usePersistentReport';
import { usePersistentReportSend } from '../components/persistent/usePersistentReportSend';
import { cardQuestionChipLabel, renderCardQuestionSurface } from '../components/persistent/cardQuestionSurface';
import { usePersistentCardCompletion } from '../components/persistent/usePersistentCardCompletion';
import { minimumReportBubbleHeight } from '../components/persistent/persistentReportStyles';
import { calculatePersistentSessionLayout } from '../../../packages/soul-ui/src/lib/persistent-session-layout';
import { PERSISTENT_SESSION_FRAME as FRAME } from '../components/persistent/persistentSessionFrame';
import { SwayCharacter } from '../components/persistent/SwayCharacter';
import { CardStatusChip } from '../components/planner/CardRow';
import { CardDetailContent } from '../components/planner/CardDetailSheet';
import { setCardQuestionTarget } from '../components/planner/CardQuestionBlock';
import { useCardActions } from '../hooks/useCardActions';
import { useSessionStore } from '../store/sessionStore';
import { ChatComposer } from '../components/chat/ChatComposer';
import { pendingReportReply } from '../lib/persistent-report';
import { persistentReportStatusCard } from '../lib/persistent-report-card';
import { CARD_QUESTION_ANSWERED_REASON } from '../components/chat/useChatSendFlow';
import { CARD_QUESTION_KEY_PREFIX } from '../../../packages/wire-schema/src/persistent_report';
import { dialogueImageUrl } from './dialogue-fixtures';

const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
type SceneId = 'ga' | 'na' | 'da' | 'ra' | 'ma' | 'ba';
const SCENES: SceneId[] = ['ga', 'na', 'da', 'ra', 'ma', 'ba'];
const sceneId: SceneId = SCENES.includes(params.get('scene') as SceneId) ? params.get('scene') as SceneId : 'ga';
const surface = params.get('surface') === 'card' ? 'card' : 'pas';
const initialExpanded = params.get('expanded') === '1';
const failWrites = params.get('fail') === '1';
const failReads = params.get('fail') === 'read';
const slowReads = params.get('slow') === '1';

const at = (minute: number) => new Date(Date.UTC(2026, 10, 12, 5, minute)).toISOString();
const asset = (module: number) => new URL(Asset.fromModule(module).uri, window.location.origin).href;
const evidenceUrl = asset(require('../../assets/icon.png'));
const portraitUrl = dialogueImageUrl();
const AGENT_SESSION = 'review-question-agent';

const secretOptions: CardQuestionOption[] = [
  { label: '파일로 옮기기', recommended: true,
    description: '비밀값을 저만 여는 파일에 두고 명령에는 파일 위치만 적습니다. 코드 수정 한 건, 대기 카드로 올립니다.' },
  { label: '서버 설정으로 가리기',
    description: '다른 계정이 남의 실행 명령을 못 보게 합니다. 코드는 그대로지만 에이전트 기록에 남는 길은 못 막습니다.' },
  { label: '그대로 두기', description: '지금처럼 둡니다. 바깥 노출이 없어 급하지는 않습니다.' },
];

type Sample = { question: CardQuestion; comments: CardComment[]; cardTitle: string; cardNumber: number; entryTitle: string };

function buildSample(scene: SceneId): Sample {
  const cardId = `review-question-${scene}`;
  const base = { cardId, sessionId: AGENT_SESSION };
  const secretTitle = '에이전트 접속 비밀값을 숨길까요?';
  const secretText = '에이전트 세션을 띄울 때마다 도구 접속 비밀값 9개가 실행 명령에 그대로 적힙니다. 서버 안의 다른 프로그램이 뚫리면 읽힐 수 있고, 처음부터 그랬습니다. 바깥으로 샌 흔적은 없습니다.';
  switch (scene) {
    case 'ga':
      return { cardTitle: '에이전트 세션 실행 명령의 접속 비밀값 정리', cardNumber: 1132, entryTitle: secretTitle,
        question: { ...base, id: 'q-secret', kind: 'choice', title: secretTitle, text: secretText,
          optionDetails: secretOptions, options: secretOptions.map(option => option.label),
          attachments: [{ type: 'image', label: '지금 실행 명령에 보이는 모습', url: evidenceUrl }],
          answer: null, askedAt: at(10) },
        // 질문 뒤에 일반 커멘트를 두어 열린 질문이 기록 맨 아래에 붙는 모습(계약 10번)을 화면에 드러낸다.
        comments: [{ id: 'c-after-question', cardId, authorKind: 'user', authorId: null, sessionId: null, kind: 'comment',
          body: '다른 카드들도 같은 방식으로 정리해 주세요.', createdAt: at(16) }] };
    case 'na':
      return { cardTitle: '에이전트 세션 실행 명령의 접속 비밀값 정리', cardNumber: 1132, entryTitle: secretTitle,
        question: { ...base, id: 'q-secret', kind: 'choice', title: secretTitle, text: secretText,
          optionDetails: secretOptions, options: secretOptions.map(option => option.label),
          attachments: [{ type: 'image', label: '지금 실행 명령에 보이는 모습', url: evidenceUrl }],
          answer: null, askedAt: at(10) },
        comments: [{ id: 'c-ask-back', cardId, authorKind: 'user', authorId: null, sessionId: null, kind: 'comment', questionId: 'q-secret',
          body: '파일로 옮기면 지금 도는 에이전트는 어떻게 되나요?', createdAt: at(12) }] };
    case 'da':
      return { cardTitle: '에이전트 세션 실행 명령의 접속 비밀값 정리', cardNumber: 1132, entryTitle: secretTitle,
        question: { ...base, id: 'q-secret', kind: 'choice', title: secretTitle, text: secretText,
          optionDetails: secretOptions, options: secretOptions.map(option => option.label),
          attachments: [{ type: 'image', label: '지금 실행 명령에 보이는 모습', url: evidenceUrl }],
          answer: '파일로 옮기기', selectedOption: '파일로 옮기기', askedAt: at(10), answeredAt: at(14) }, comments: [] };
    case 'ra':
      return { cardTitle: '카드 질문 장 고치기: 선택지 설명, 다르게 답하기, 되묻기', cardNumber: 1197, entryTitle: '아이폰 앱을 업데이트해 주십시오',
        question: { ...base, id: 'q-request', kind: 'request', title: '아이폰 앱을 업데이트해 주십시오',
          text: '질문 장이 바뀐 판이 TestFlight에 올라왔습니다.\n\n1. 아이폰에서 TestFlight를 엽니다.\n2. 소울스트림 옆의 「업데이트」를 누릅니다.\n3. 앱을 다시 열어 PAS 판의 질문 장을 봅니다.',
          options: null, answer: null, askedAt: at(30) }, comments: [] };
    case 'ma':
      return { cardTitle: 'MCP 인증 헤더를 설정 파일로 옮기는 후속 카드', cardNumber: 1131, entryTitle: 'MCP 인증 헤더를 설정 파일로 옮길까요?',
        question: { ...base, id: 'q-legacy',
          text: 'claude CLI 인자에 MCP 인증 헤더가 통째로 실려 같은 서버의 다른 계정이 읽을 수 있습니다(외부 노출은 확인 안 됨). 설정을 0600 파일로 넘기게 고치는 후속 카드를 만들까요?',
          options: ['후속 카드 생성', 'hidepid로 막기', '그대로 둔다'], answer: null, askedAt: at(5) }, comments: [] };
    case 'ba':
      return { cardTitle: '에이전트 세션 실행 명령의 접속 비밀값 정리', cardNumber: 1132, entryTitle: secretTitle,
        question: { ...base, id: 'q-secret', kind: 'choice', title: secretTitle,
          text: '에이전트 세션을 띄울 때마다 도구 접속 비밀값 9개가 실행 명령에 그대로 적힙니다. 서버 안의 다른 프로그램이 뚫리면 읽힐 수 있고, 처음부터 그랬습니다. 바깥으로 샌 흔적은 없습니다. 지금 도는 에이전트에도 같은 값이 실려 있는지 다시 확인해 배경에 적었습니다.',
          optionDetails: secretOptions, options: secretOptions.map(option => option.label),
          answer: null, askedAt: at(10), revision: 2, revisedAt: at(18) }, comments: [] };
  }
}

const sample = buildSample(sceneId);
const request = sample.question.kind === 'request';
const card = cardFixture({ id: sample.question.cardId, number: sample.cardNumber, status: 'blocked', blockedKind: 'question',
  title: sample.cardTitle, request: request ? '새 판에서 질문 장을 직접 보시면 마무리합니다.' : '에이전트 세션을 띄우는 실행 명령에 접속 비밀값이 그대로 실리는지 확인하고 막을 길을 정한다.',
  assigneeKind: 'session', assigneeAgentId: 'seosoyoung', assigneeSessionId: AGENT_SESSION, nodeId: 'eiaserinnys',
  now: { text: request ? '새 판에서 질문 장을 직접 보시면 마무리합니다.' : '비밀값을 어디에 둘지 정해 주시면 바로 진행합니다.', turn: 'user', ask: null, updatedAt: at(10), sessionId: AGENT_SESSION } });
const reviewSession = { agentSessionId: AGENT_SESSION, displayName: '서소영', status: 'idle', createdAt: at(0), updatedAt: at(0),
  agentId: 'seosoyoung', agentName: '서소영', agentPortraitUrl: portraitUrl, nodeId: 'eiaserinnys' } as unknown as Session;
useSessionStore.setState(state => ({ ...state, sessions: { ...state.sessions, [reviewSession.agentSessionId]: reviewSession } }));

// da는 선택 답 뒤에 서는 「덧붙이기: 이름」 대상 줄을 그대로 보인다. 초점은 옮기지 않는다(계약 3절 2번).
if (sceneId === 'da') setCardQuestionTarget(card.id, { kind: 'append', questionId: sample.question.id, label: '파일로 옮기기' });

function sampleEntry(): PersistentReportEntry {
  const question = sample.question;
  const thread = sample.comments.filter(comment => comment.questionId === question.id);
  return {
    key: `${CARD_QUESTION_KEY_PREFIX}${question.id}`, kind: 'ask', title: sample.entryTitle,
    card_numbers: [sample.cardNumber], context: question.text, action: '', options: question.options ?? [],
    question_id: question.id, state: question.answer === null ? 'open' : 'answered', answer: question.answer ?? '',
    updated_at: at(30), card_id: card.id, card_status: 'blocked',
    question_title: question.title ?? sample.entryTitle,
    question_text: question.text,
    question_kind: question.kind ?? 'choice',
    question_option_details: question.optionDetails,
    question_attachments: question.attachments,
    question_thread: thread.map(comment => ({ id: comment.id, question_id: question.id, author_kind: comment.authorKind,
      body: comment.body, created_at: comment.createdAt, session_id: comment.sessionId })),
    question_revision: question.revision ?? 1,
    question_revised_at: question.revisedAt ?? null,
  };
}

function fail(): never {
  throw new Error('공개 예시: 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
}

function createSampleApi(onReportAnswered?: (key: string) => void): ApiClient {
  let detail: CardDetail = { card: { ...card }, reports: [], questions: [{ ...sample.question }], sessions: [reviewSession],
    comments: sample.comments.map(comment => ({ ...comment })), nowHistory: [] };
  const snapshot = (): CardDetail => ({ ...detail, card: { ...detail.card, items: [...(detail.card.items ?? [])] },
    questions: detail.questions.map(question => ({ ...question })), comments: [...(detail.comments ?? [])] });
  const save = (next: CardDetail) => { detail = next; return snapshot(); };
  // 검수 창에서 읽기 실패(?fail=read)와 느린 응답(?slow=1)을 잴 수 있게 한다.
  async function read<T>(value: T): Promise<T> {
    if (slowReads) await new Promise(resolve => setTimeout(resolve, 2500));
    if (failReads) throw new Error('공개 예시: 카드를 불러오지 못했습니다.');
    return value;
  }
  return {
    listCards: async () => read({ cards: [snapshot().card] }),
    getCard: async (id: string) => {
      const saved = await read(snapshot());
      if (id !== detail.card.id) throw new Error('공개 예시: 없는 카드입니다.');
      return saved;
    },
    setCardStatus: async (id: string, status: CardStatus, expectedVersion: number) => {
      if (id !== detail.card.id || expectedVersion !== detail.card.version) fail();
      detail = { ...detail, card: { ...detail.card, status, version: detail.card.version + 1 } };
      return { folderId: detail.card.folderId, card: detail.card };
    },
    confirmCardItem: async (_cardId: string, itemId: number, confirmed: boolean) => {
      const nextItems = (detail.card.items ?? []).map((item: CardCheckItem) => item.id !== itemId ? item : { ...item,
        confirmed: confirmed ? { at: at(31), rev: item.rev } : null,
        display: confirmed ? 'confirmed' as const : item.state === 'done' ? 'reported' as const : 'todo' as const });
      detail = { ...detail, card: { ...detail.card, items: nextItems } };
      return { folderId: detail.card.folderId, card: detail.card };
    },
    addCardComment: async (cardId: string, input: { body: string; itemId?: number; questionId?: string; idempotencyKey: string }) => {
      if (failWrites) fail();
      const comment: CardComment = { id: input.idempotencyKey, cardId, authorKind: 'user', authorId: null, sessionId: null, kind: 'comment',
        ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
        ...(input.questionId === undefined ? {} : { questionId: input.questionId }),
        body: input.body, createdAt: new Date().toISOString() };
      save({ ...detail, comments: [...(detail.comments ?? []), comment] });
      return comment;
    },
    answerCardQuestion: async (_cardId: string, questionId: string, input: { mode: 'choice'; option: string } | { mode: 'text'; answer: string }) => {
      if (failWrites) fail();
      const answer = input.mode === 'choice' ? input.option : input.answer;
      save({ ...detail, questions: detail.questions.map(question => question.id === questionId
        ? { ...question, answer, answeredAt: new Date().toISOString(),
          ...(input.mode === 'choice' ? { selectedOption: input.option } : { selectedOption: null }) }
        : question) });
      // 서버의 판 재계산처럼 답한 cq_ 장을 판 목록에서도 뺀다.
      onReportAnswered?.(`${CARD_QUESTION_KEY_PREFIX}${questionId}`);
      return { folderId: detail.card.folderId, card: detail.card };
    },
    // 표본은 운영의 판 답 보내기 경로를 그대로 타고, API 경계에서만 응답을 대신한다.
    // 판 재계산에서 답한 cq_ 장이 빠지는 서버 동작을 서버 목록을 줄여 흉내 내고,
    // 판 답 ACK가 카드 상세의 질문에도 답을 남기는 서버 효과를 함께 재현한다.
    intervene: async (_sessionId: string, _text: string, _paths?: string[], contextItems?: MessageContextItem[]) => {
      const reply = pendingReportReply(contextItems);
      if (reply) {
        onReportAnswered?.(reply.key);
        if (reply.key.startsWith(CARD_QUESTION_KEY_PREFIX)) {
          const questionId = reply.key.slice(CARD_QUESTION_KEY_PREFIX.length);
          save({ ...detail, questions: detail.questions.map(question => question.id === questionId
            ? { ...question, answer: reply.option, selectedOption: reply.option, answeredAt: new Date().toISOString() }
            : question) });
        }
      }
      return { delivered: true, outcome: 'delivered' as const, ...(reply ? { reason: CARD_QUESTION_ANSWERED_REASON } : {}) };
    },
  } as unknown as ApiClient;
}

function PasScene() {
  const t = useTokens();
  const phone = useDeviceType() === 'phone';
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // 서버 판 목록. 표본의 답 보내기는 운영 경로를 그대로 타고, API 경계의 intervene가 답한 cq_ 장을 걷어 둔다.
  const [serverEntries, setServerEntries] = useState<PersistentReportEntry[]>(() => [sampleEntry()]);
  const [cardSheetOpen, setCardSheetOpen] = useState<boolean>(initialExpanded && phone);
  const [expandedKey, setExpandedKey] = useState<string | null>(initialExpanded ? serverEntries[0]?.key ?? null : null);
  const [text, setText] = useState('');
  // 판 재계산 갱신은 선택 ACK를 받은 뒤에 온다. 갱신이 먼저 닿으면 붙들기 전에 장이 목록에서 빠져
  // 펼친 장이 닫힌 것으로 보이므로, 표본은 운영 순서대로 붙들기를 먼저 세우고 목록을 줄인다.
  const answeredKeys = useRef<string[]>([]);
  const removeAnswered = useCallback(() => {
    if (!answeredKeys.current.length) return;
    const keys = answeredKeys.current;
    answeredKeys.current = [];
    setServerEntries(saved => saved.filter(entry => !keys.includes(entry.key)));
  }, []);
  const api = useMemo(() => createSampleApi(key => { answeredKeys.current.push(key); }), []);
  const report = usePersistentReport('review-question-pas', true, api, serverEntries, undefined);
  const reportSend = usePersistentReportSend('review-question-pas', api, report.entries, report.server, 'completed', () => {},
    (entry, option) => { report.holdAnswered(entry, option); removeAnswered(); });
  const questionActions = useCardActions(api);
  const completion = usePersistentCardCompletion(api);
  const column = phone ? width - t.foundation.pageInset * 2 : FRAME.landscape.conversation;
  const left = (width - column) / 2;
  const layout = calculatePersistentSessionLayout({ app: { left: 0, top: 0, width, height },
    header: { left: 0, top: 0, width, height: FRAME.header + insets.top },
    main: { left, top: FRAME.header + insets.top, width: column, height: height - FRAME.header - insets.top },
    baselineBottom: height - insets.bottom - t.uiSpacing.lg, inputRowHeight: t.hitTarget.min,
    rowBottomGap: t.spacing.xs, pointerFine: false, showCharacter: true, phoneConfigured: phone,
    reportBubble: { widthScale: 1, minimumHeight: minimumReportBubbleHeight(t) } });
  const pager = <PersistentReportPager entries={reportSend.entries} index={report.index} api={api} sessionId="review-question-pas"
    completion={completion} expandedKey={phone ? null : expandedKey} onExpandedKeyChange={setExpandedKey}
    onSelect={report.select} onDismiss={async key => { setServerEntries(saved => saved.filter(entry => entry.key !== key)); }} onFocusComposer={() => {}}
    bubble={Boolean(layout.reportBubble)} maxHeight={layout.reportBubble?.maxHeight ?? layout.reportViewMaxHeight}
    renderCardStatus={entry => {
      const statusCard = persistentReportStatusCard(entry);
      if (!statusCard) return null;
      return <CardStatusChip card={statusCard} detail label={cardQuestionChipLabel(entry, statusCard.blockedKind)} />;
    }}
    renderCardDetails={phone ? undefined
      : (entry, publish) => <PersistentReportCardExpansion key={entry.key} api={api} entry={entry} onQuestionView={publish} />}
    onOpenCardDetails={phone ? () => setCardSheetOpen(true) : undefined}
    renderQuestion={(entry, controls) => renderCardQuestionSurface(entry, controls, {
      t, api, portraitUri: portraitUrl, questionActions, reportSend,
      onAnswered: (answered, option) => { report.holdAnswered(answered, option); removeAnswered(); },
    })}
    send={reportSend} />;
  return <ContentLinkProvider><ChatUiControllerProvider sessionId="review-question-pas" appendGeneratedText={() => ({ ok: true })}>
    {phone && cardSheetOpen ? <View style={{ flex: 1, backgroundColor: t.colors.background }}>
      {/* 카드 시트의 REST 선택은 붙들지 않는다(위임자 결정). 판으로 돌아갈 때 재계산 갱신을 적용한다. */}
      <CardDetailContent visible api={api} cardId={card.id} onClose={() => { setCardSheetOpen(false); removeAnswered(); }} />
    </View> :
      <View testID="card-question-pas-sample" style={{ flex: 1, backgroundColor: t.persistentSession.paper, paddingTop: insets.top, paddingBottom: insets.bottom }}>
        <View style={{ flex: 1, minHeight: 0, width: column, alignSelf: 'center', gap: t.uiSpacing.lg, justifyContent: 'flex-end' }}>
          {phone || !layout.reportBubble ? pager : null}
        </View>
        <View style={{ width: column, alignSelf: 'center' }}><ChatComposer input={text} onChangeInput={setText} onSend={() => setText('')} onPickAttachment={() => {}}
          uploading={false} sending={false} voiceControls={null} presentation="manuscript" /></View>
        {layout.body ? <View pointerEvents="none" style={{ position: 'absolute', left: layout.body.left, top: layout.body.top, width: layout.body.width, height: layout.body.height }}>
          <SwayCharacter width={layout.body.width} height={layout.body.height} shown motionEnabled={false} active={false} />
        </View> : null}
        {layout.reportBubble ? <View testID="card-question-pas-bubble" style={{ position: 'absolute', left: layout.reportBubble.left,
          bottom: height - layout.reportBubble.bottom, width: layout.reportBubble.width }}>{pager}</View> : null}
      </View>}
  </ChatUiControllerProvider></ContentLinkProvider>;
}

function CardScene() {
  const t = useTokens();
  const phone = useDeviceType() === 'phone';
  const api = useMemo(() => createSampleApi(), []);
  return <ContentLinkProvider><View testID="card-question-card-sample" style={{ flex: 1, backgroundColor: t.colors.background }}>
    <CardDetailContent visible inline={!phone} api={api} cardId={card.id} onClose={() => {}} />
  </View></ContentLinkProvider>;
}

export function ReviewCardQuestion() {
  return surface === 'card' ? <CardScene /> : <PasScene />;
}
