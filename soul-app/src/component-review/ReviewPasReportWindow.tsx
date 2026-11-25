// 카드 #1871: PAS 결재형 보고 창의 앱 검수 견본. 운영과 같은 부품(PasReportWindow)을 운영 형태 데이터로 그린다.
// 서버에는 묻지 않는다. 가짜 서버(fakeServer)가 카드 목록, 상세, 답, 커멘트, 미루기, 완료를 받는다.
//   ?section=pasReport&state=review|question|request|blocked|running|verifying|snoozed|processed|empty|loading|error|cardsError&theme=light|dark
import React, { useMemo, useState } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { CardComment, CardDetail, CardDto, CardQuestion } from '../api/cardTypes';
import { CARD_QUESTION_KEY_PREFIX, type PersistentReportEntry } from '../../../packages/wire-schema/src/persistent_report';
import { getFolderWorkspaceOverlayWidth } from '../lib/folder-workspace-layout';
import { entryAgenda, type Agenda } from '../lib/pas-report-thread-model';
import type { ProcessedAgenda } from '../../../packages/soul-ui/src/lib/pas-report-thread-core';
import { ContentLinkProvider } from '../navigation/ContentLinkProvider';
import { PasReportWindow } from '../components/pasReport/PasReportWindow';
import { usePersistentCardCompletion } from '../components/persistent/usePersistentCardCompletion';
import { usePersistentReport } from '../components/persistent/usePersistentReport';
import { CardPanelOverlayFrame } from '../components/planner/FolderWorkspaceReadOverlay';
import { useSessionStore } from '../store/sessionStore';
import { useCardStore } from '../store/cardStore';
import { useDeviceType, useTokens } from '../theme';
import { cardFixture } from '../test-support/cards';
import { checkItem, fakeServer, reportEntry } from '../test-support/pas-report';
import type { Session } from '../api/types';

const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
type PasReportSampleState = 'review' | 'question' | 'request' | 'blocked' | 'running' | 'verifying' | 'snoozed' | 'processed' | 'empty' | 'loading' | 'error' | 'cardsError';
const STATES: PasReportSampleState[] = ['review', 'question', 'request', 'blocked', 'running', 'verifying', 'snoozed', 'processed', 'empty', 'loading', 'error', 'cardsError'];
const state: PasReportSampleState = STATES.includes(params.get('state') as PasReportSampleState) ? params.get('state') as PasReportSampleState : 'review';

const NOW = Date.now();
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const tomorrowMorning = () => { const at = new Date(NOW); at.setDate(at.getDate() + 1); at.setHours(9, 0, 0, 0); return at.toISOString(); };
const AGENT_SESSION = 'review-pas-report-agent';
const REVIEWER_SESSION = 'review-pas-report-reviewer';

const reviewTitle = 'PAS 결재형 보고 창 앱 구현: 레일, 스레드, 결재 상자, 답변 미루기, 카드 패널 열기까지 휴대폰과 태블릿에서';
const questionTitle = '에이전트 세션을 띄울 때마다 실행 명령에 적히는 도구 접속 비밀값 아홉 개를 어디까지 가릴지 정해 주세요';
const secretOptions = [
  { label: '파일로 옮기기', recommended: true, description: '비밀값을 저만 여는 파일에 두고 명령에는 파일 위치만 적습니다. 코드 수정 한 건이라 대기 카드로 올립니다.' },
  { label: '서버 설정으로 가리기', description: '다른 계정이 남의 실행 명령을 못 보게 합니다. 코드는 그대로지만 에이전트 기록에 남는 길은 못 막습니다.' },
  { label: '그대로 두기', description: '지금처럼 둡니다. 바깥 노출이 없어 급하지는 않습니다.' },
];

const session = (id: string, agentId: string, agentName: string, minutes: number) => ({
  agentSessionId: id, agentId, agentName, displayName: agentName, status: 'running', nodeId: 'silent-manari-ts',
  createdAt: minutesAgo(minutes), updatedAt: minutesAgo(minutes - 1),
}) as unknown as Session;
const base = (id: string, number: number, patch: Partial<CardDto>) => cardFixture({
  id, number, folderId: 'folder-soulstream', assigneeKind: 'session', assigneeAgentId: 'utonium', assigneeSessionId: AGENT_SESSION,
  nodeId: 'silent-manari-ts', createdAt: minutesAgo(300), updatedAt: minutesAgo(20), ...patch });

function build() {
  const items = [
    checkItem({ id: 1, title: '390 폭에서 결재 상자 단추가 두 줄로 감겨도 주 단추가 첫 자리다', result: '390과 360 모두 감겨도 채운 단추가 첫 자리입니다.',
      caveat: '실기기 아이폰에서는 보지 못했습니다.', reportedAt: minutesAgo(30) }),
    checkItem({ id: 2, title: '답변 미루기 선택지는 18시 뒤에 오늘 저녁을 뺀다', state: 'done', display: 'confirmed', confirmed: { at: minutesAgo(25), rev: 1 }, result: '17:59와 18:00 경계를 시험으로 덮었습니다.' }),
    checkItem({ id: 3, title: '카드 패널을 열었다 돌아오면 같은 안건 같은 스크롤 위치다', state: 'doing', display: 'doing', result: null, reportedAt: null }),
  ];
  const reviewCard = base('card-1871', 1871, { status: 'review', title: reviewTitle, items,
    request: 'PAS 결재형 보고 창을 아이폰 소울앱에 실제 데이터로 구현해 주세요.\n\n- 세로 안건 목록과 맨 아래 자동 스크롤\n- 복귀 알약과 카드 패널 열기\n- 답변 미루기\n\n웹판 PR의 동작과 문구를 맞추고 코드는 옮겨 오지 않습니다.',
    now: { text: '앱 화면을 모두 만들었고 캡처로 폭별 모양을 확인하는 중입니다.', turn: 'agent', ask: null, updatedAt: minutesAgo(12), sessionId: AGENT_SESSION } });
  const comments: CardComment[] = [
    { id: 'c1', cardId: reviewCard.id, authorKind: 'user', authorId: 'director', sessionId: null, kind: 'comment', body: '아이패드 가로에서도 같은 순서로 나오는지 봐 줘.', createdAt: minutesAgo(90) },
    { id: 'c2', cardId: reviewCard.id, authorKind: 'agent', authorId: 'utonium', sessionId: AGENT_SESSION, kind: 'comment', body: '네, 820과 1180에서 레일 폭과 단추 순서를 맞춰 보았습니다.', createdAt: minutesAgo(80) },
    { id: 'c3', cardId: reviewCard.id, authorKind: 'user', authorId: 'director', sessionId: null, kind: 'spoken', body: '결재 상자 입력창은 카드 상세 커멘트 입력과 같은 부품이어야 해.', createdAt: minutesAgo(70) },
    { id: 'n1', cardId: reviewCard.id, authorKind: 'agent', authorId: 'utonium', sessionId: AGENT_SESSION, kind: 'note', body: '워크트리 soulstream--card1871-pas-report-app-7dd78af8, 브랜치 card1871-pas-report-app, 기준 df05c867.', createdAt: minutesAgo(60) },
    { id: 'n2', cardId: reviewCard.id, authorKind: 'agent', authorId: 'utonium', sessionId: AGENT_SESSION, kind: 'note', body: '앱 단위 시험 pas-report-thread-model 22개, PasReportWindow 29개 통과(커밋 a1b2c3d 기준).', createdAt: minutesAgo(59) },
    { id: 'n3', cardId: reviewCard.id, authorKind: 'agent', authorId: 'utonium', sessionId: AGENT_SESSION, kind: 'note', body: '세션 7f03b426-307f-43a5-b06d-bd8d0905f7e1에서 캡처 스크립트를 돌렸고 로그는 logs/ 아래에 있습니다.', createdAt: minutesAgo(58) },
  ];
  const reviewDetail: Partial<CardDetail> = {
    comments, sessions: [session(AGENT_SESSION, 'utonium', '서소영', 280), session(REVIEWER_SESSION, 'selaphiel', '세라피엘', 40)],
    nowHistory: [
      { text: '웹판 코드를 읽고 앱 부품과 대응을 정리하는 중입니다.', turn: 'agent', ask: null, at: minutesAgo(240) },
      { text: '순수 로직과 시험을 먼저 옮기고 있습니다.', turn: 'agent', ask: null, at: minutesAgo(150) },
      { text: '앱 화면을 모두 만들었고 캡처로 폭별 모양을 확인하는 중입니다.', turn: 'agent', ask: null, at: minutesAgo(12) },
    ],
    statusHistory: [
      { status: 'running', at: minutesAgo(290), actorKind: 'agent', sessionId: AGENT_SESSION },
      { status: 'review', at: minutesAgo(11), actorKind: 'agent', sessionId: AGENT_SESSION },
    ],
  };
  const question: CardQuestion = { id: 'q-secret', cardId: 'card-1865', sessionId: AGENT_SESSION, kind: 'choice', title: '비밀값을 어디까지 가릴까요?',
    text: '에이전트 세션을 띄울 때마다 도구 접속 비밀값 9개가 실행 명령에 그대로 적힙니다. 서버 안의 다른 프로그램이 뚫리면 읽힐 수 있고, 처음부터 그랬습니다. 바깥으로 샌 흔적은 없습니다.',
    options: secretOptions.map(option => option.label), optionDetails: secretOptions, askedAt: minutesAgo(50),
    // 처리됨 표본은 이 창에서 답한 뒤의 모양이다. 질문은 답한 것으로, 판의 질문 장은 빠진 것으로 둔다.
    ...(state === 'processed' ? { answer: '파일로 옮기기', selectedOption: '파일로 옮기기', answeredAt: minutesAgo(1) } : { answer: null }) };
  const questionCard = base('card-1865', 1865, { status: 'blocked', blockedKind: 'question', title: questionTitle, request: '실행 명령에 접속 비밀값이 실리는지 확인하고 막을 길을 정한다.' });
  const requestQuestion: CardQuestion = { id: 'q-update', cardId: 'card-1869', sessionId: AGENT_SESSION, kind: 'request', title: '아이폰 앱을 업데이트해 주십시오',
    text: '보고 창이 들어간 판이 TestFlight에 올라왔습니다.\n\n1. 아이폰에서 TestFlight를 엽니다.\n2. 소울스트림 옆의 「업데이트」를 누릅니다.\n3. 앱을 다시 열어 보고 창을 봅니다.', options: null, answer: null, askedAt: minutesAgo(35) };
  const requestCard = base('card-1869', 1869, { status: 'blocked', blockedKind: 'question', title: '아이폰 앱을 업데이트해 주십시오', request: '새 판을 직접 보시면 마무리합니다.' });
  const blockedCard = base('card-1850', 1850, { status: 'blocked', blockedKind: 'limit', title: 'Claude 계정 한도에 걸려 카드 실행이 멈춤', request: '한도 해제 뒤 이어서 실행한다.',
    blockedDetail: '계정 한도에 걸렸습니다.' });
  const snoozedCard = base('card-1830', 1830, { status: 'review', title: '카드 의존 관계 서버와 MCP 구현 검수', snoozedUntil: tomorrowMorning(), request: '의존 관계를 서버와 MCP에 구현한다.' });
  const runningCard = base('card-1840', 1840, { status: 'running', title: '하니엘 풀 배포 뒤 노드 연결 확인', updatedAt: minutesAgo(5), request: '배포 뒤 네 노드 연결을 확인한다.' });
  const verifyingCard = base('card-1842', 1842, { status: 'awaiting_verification', title: '무중단 재시작 후 세션 이어받기 검증', updatedAt: minutesAgo(45), request: '재시작 뒤 세션 이어받기를 확인한다.' });
  const holds = Array.from({ length: 18 }, (_, index) => base(`hold-${index}`, 1700 + index, { status: 'on_hold', title: `보류 카드 ${index + 1}` }));
  const cards = [reviewCard, questionCard, requestCard, blockedCard, snoozedCard, runningCard, verifyingCard, ...holds];
  const entry = (card: CardDto, patch: Partial<PersistentReportEntry> = {}) => reportEntry({ key: `card_${card.id}`, card_id: card.id, card_numbers: [card.number ?? 0],
    title: card.title, card_status: card.status, updated_at: minutesAgo(20), ...patch });
  const questionEntry = entry(questionCard, { key: `${CARD_QUESTION_KEY_PREFIX}${question.id}`, kind: 'ask', question_id: question.id, question_kind: 'choice', title: question.title ?? questionTitle });
  const entries = [
    ...(state === 'processed' ? [] : [questionEntry]),
    entry(requestCard, { key: `${CARD_QUESTION_KEY_PREFIX}${requestQuestion.id}`, kind: 'ask', question_id: requestQuestion.id, question_kind: 'request' }),
    entry(reviewCard), entry(blockedCard), entry(snoozedCard),
  ];
  const details: Record<string, Partial<CardDetail>> = {
    [reviewCard.id]: reviewDetail,
    [questionCard.id]: { questions: [question], comments: [
      { id: 'ask1', cardId: questionCard.id, questionId: question.id, authorKind: 'user', authorId: 'director', sessionId: null, kind: 'comment', body: '파일로 옮기면 지금 도는 에이전트는 어떻게 되나요?', createdAt: minutesAgo(40) },
      { id: 'ask2', cardId: questionCard.id, questionId: question.id, authorKind: 'agent', authorId: 'utonium', sessionId: AGENT_SESSION, kind: 'comment', body: '이미 도는 세션은 그대로 두고 새로 뜨는 세션부터 파일을 읽습니다.', createdAt: minutesAgo(38) },
    ] },
    [requestCard.id]: { questions: [requestQuestion] },
  };
  return { cards, entries, details, questionEntry };
}

const startOf: Record<PasReportSampleState, string | null> = {
  review: 'card-1871', question: 'card-1865', request: 'card-1869', blocked: 'card-1850', running: 'card-1840', verifying: 'card-1842',
  snoozed: 'card-1830', processed: 'card-1865', empty: null, loading: 'card-1871', error: 'card-1871', cardsError: 'card-1871',
};

export function ReviewPasReportWindow() {
  const t = useTokens();
  // 기기 종류는 처음 열 때 정한다. 아이패드 창 폭이 줄어도 겹침은 그대로 서 있고 창 폭에 맞춰 배치만 바뀐다.
  const device = useDeviceType();
  const [phone] = useState(device === 'phone');
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const sample = useMemo(() => {
    const data = build();
    const cards = state === 'empty' ? [] : data.cards;
    const server = fakeServer(cards, data.details);
    for (const card of cards) useCardStore.getState().putCard(card);
    if (state === 'loading') server.hang('getCard');
    if (state === 'error') server.failNext('getCard', '공개 예시: 카드를 불러오지 못했습니다.');
    if (state === 'cardsError') server.failNext('listCards', '공개 예시: 카드 목록을 불러오지 못했습니다.');
    useSessionStore.setState(current => ({ ...current, sessions: { ...current.sessions,
      [AGENT_SESSION]: session(AGENT_SESSION, 'utonium', '서소영', 280) } }));
    return { ...data, cards, server };
  }, []);
  const [serverEntries, setServerEntries] = useState<PersistentReportEntry[]>(() => state === 'empty' ? [] : sample.entries);
  const completion = usePersistentCardCompletion(sample.server.api);
  const report = usePersistentReport('review-pas-report', true, sample.server.api, serverEntries, undefined, completion.filterEntries);
  const initialProcessed = useMemo<ProcessedAgenda<Agenda>[] | undefined>(() => {
    if (state !== 'processed') return undefined;
    const done = sample.cards.find(card => card.id === 'card-1865');
    const agenda = done ? entryAgenda(sample.questionEntry, done) : null;
    return agenda ? [{ agenda, label: '답함' }] : undefined;
  }, [sample]);
  const dismissReport = React.useCallback(async (key: string) => {
    setServerEntries(saved => saved.filter(entry => entry.key !== key));
    return true;
  }, []);
  const windowView = <PasReportWindow api={sample.server.api} entries={report.entries} completion={completion} dismissReport={dismissReport}
    startCardId={startOf[state]} initialProcessed={initialProcessed} onClose={() => {}} onOpenCard={() => {}} />;
  return <ContentLinkProvider>
    {phone
      ? <SafeAreaView testID="pas-report-review-phone" edges={['top', 'left', 'right']} style={{ flex: 1, paddingTop: t.uiSpacing.md, backgroundColor: t.colors.background }}>{windowView}</SafeAreaView>
      : <View testID="pas-report-review-tablet" style={{ flex: 1, backgroundColor: t.colors.background }}>
        <CardPanelOverlayFrame visible width={getFolderWorkspaceOverlayWidth(width)} direction="column" sheetTop={insets.top}
          onClose={() => {}} testID="pas-report-overlay">{windowView}</CardPanelOverlayFrame>
      </View>}
  </ContentLinkProvider>;
}
