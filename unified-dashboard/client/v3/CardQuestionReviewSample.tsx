// 카드 #1197: 카드 질문 장의 실제 구현 표본. 검수 창(/components)과 시각 검증 스크립트가
// 운영과 같은 부품(CardDetailPane, PersistentReportDeck + pasCardQuestion, PasCardExpansion)을
// 같은 폭과 상태로 연다. 장면 이름은 시안(df63ae1b1)의 ga, na, da, ra, legacy를 그대로 쓴다.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { flushSync } from 'react-dom';
import { useDashboardStore, type PersistentReportEntry } from '@seosoyoung/soul-ui';
import { PersistentReportProvider } from '@seosoyoung/soul-ui/components/persistent-report/PersistentReportProvider';
import { calculatePersistentSessionLayout } from '@seosoyoung/soul-ui/lib/persistent-session-layout';
import { useCardStore } from '@seosoyoung/soul-ui/cards/card-store';
import type { CardComment, CardDetail, CardQuestion, CardRow } from '@seosoyoung/soul-ui/cards/card-types';
import { CardDetailPane } from './CardDetailPane';
import { CardQuestionActions, CardQuestionBody, CardQuestionAnswered, cardQuestionDetailView } from './CardQuestionBlock';
import { PersistentReportDeck, type ReportBubbleSeat } from './PersistentReportDeck';
import { PasCardExpansion, PasCardExpansionStatus, pasCardQuestion } from './PasCardExpansion';
import { cardDetailTargetScope, pasSheetTargetScope, setCardQuestionTarget } from './card-question-target';
import { useCardApiSample } from './card-sample-api';
import { REPORT_BUBBLE_MINIMUM_HEIGHT } from './use-persistent-session-geometry';
import { reviewCard, reviewDetail, reviewNow } from './components-review-fixtures';
import './persistent-session-screen.css';

export type CardQuestionScene = 'ga' | 'na' | 'da' | 'ra' | 'legacy';

const at = (minute: number) => new Date(Date.UTC(2026, 10, 12, 5, minute)).toISOString();

const secretQuestion: CardQuestion = {
  id: 'q-secret', kind: 'choice', title: '에이전트 접속 비밀값을 숨길까요?',
  text: '에이전트 세션을 띄울 때마다 도구 접속 비밀값 9개가 실행 명령에 그대로 적힙니다. 서버 안의 다른 프로그램이 뚫리면 읽힐 수 있고, 처음부터 그랬습니다. 바깥으로 샌 흔적은 없습니다.',
  options: ['파일로 옮기기', '서버 설정으로 가리기', '그대로 두기'],
  optionDetails: [
    { label: '파일로 옮기기', description: '비밀값을 저만 여는 파일에 두고 명령에는 파일 위치만 적습니다. 코드 수정 한 건, 대기 카드로 올립니다.', recommended: true },
    { label: '서버 설정으로 가리기', description: '다른 계정이 남의 실행 명령을 못 보게 합니다. 코드는 그대로지만 에이전트 기록에 남는 길은 못 막습니다.' },
    { label: '그대로 두기', description: '지금처럼 둡니다. 바깥 노출이 없어 급하지는 않습니다.' },
  ],
  attachments: [{ type: 'image', label: '지금 실행 명령에 보이는 모습', url: '/icon-512.png', previewUrl: '/icon-512.png' }],
  answer: null, askedAt: at(10), answeredAt: null,
};
const answeredQuestion: CardQuestion = { ...secretQuestion, answer: '파일로 옮기기', selectedOption: '파일로 옮기기', answeredAt: at(14) };
const threadQuestion: CardQuestion = { ...secretQuestion, revision: 2, revisedAt: at(18) };
const requestQuestion: CardQuestion = {
  id: 'q-request', kind: 'request', title: '아이폰 앱을 업데이트해 주십시오',
  text: '질문 장이 바뀐 판이 TestFlight에 올라왔습니다.\n\n1. 아이폰에서 TestFlight를 엽니다.\n2. 소울스트림 옆의 「업데이트」를 누릅니다.\n3. 앱을 다시 열어 PAS 판의 질문 장을 봅니다.',
  options: ['했어'], answer: null, askedAt: at(30), answeredAt: null,
};
const legacyQuestion: CardQuestion = {
  id: 'q-legacy',
  text: 'claude CLI 인자에 MCP 인증 헤더가 통째로 실려 같은 서버의 다른 계정이 읽을 수 있습니다(외부 노출은 확인 안 됨). 설정을 0600 파일로 넘기게 고치는 후속 카드를 만들까요?',
  options: ['후속 카드 생성', 'hidepid로 막기', '그대로 둔다'], answer: null, askedAt: at(5), answeredAt: null,
};

const questionFor: Record<CardQuestionScene, CardQuestion> = { ga: secretQuestion, na: answeredQuestion, da: threadQuestion, ra: requestQuestion, legacy: legacyQuestion };
const threadFor: Record<CardQuestionScene, CardComment[]> = {
  ga: [], na: [], ra: [], legacy: [],
  da: [
    { id: 't1', cardId: 'card-da', authorKind: 'user', authorId: 'sample', sessionId: null, kind: 'comment', questionId: 'q-secret', body: '파일로 옮기면 어떻게 해결 돼?', createdAt: at(12) },
    { id: 't2', cardId: 'card-da', authorKind: 'agent', authorId: 'roselin', sessionId: null, kind: 'comment', questionId: 'q-secret', body: '지금은 비밀값이 실행 명령 안에 들어 있어서, 같은 서버의 다른 프로그램이 명령 목록만 봐도 읽힙니다. 파일로 옮기면 명령에는 파일 위치만 남고, 그 파일은 에이전트 계정만 열 수 있습니다.', createdAt: at(18) },
    { id: 't3', cardId: 'card-da', authorKind: 'user', authorId: 'sample', sessionId: null, kind: 'comment', questionId: 'q-secret', body: '이전부터 있던 문제지?', createdAt: at(20) },
  ],
};

function cardFor(scene: CardQuestionScene): CardRow {
  const question = questionFor[scene];
  return {
    ...reviewCard, id: `card-${scene}`, number: question.kind === 'request' ? 1197 : 1132,
    title: question.kind === 'request' ? '카드 질문 장 고치기: 선택지 설명, 다르게 답하기, 되묻기' : '에이전트 세션 실행 명령의 접속 비밀값 정리',
    request: '에이전트 세션을 띄우는 실행 명령에 접속 비밀값이 그대로 실리는지 확인하고 막을 길을 정한다.',
    status: 'blocked', blockedKind: 'question', assigneeKind: 'agent', assigneeAgentId: 'roselin', assigneeSessionId: null,
    nodeId: null, items: [],
    now: { ...reviewNow, text: question.kind === 'request' ? '새 판에서 질문 장을 직접 보시면 마무리합니다.' : '비밀값을 어디에 둘지 정해 주시면 바로 진행합니다.', ask: null, turn: 'user', updatedAt: at(10) },
  };
}

function detailFor(scene: CardQuestionScene): CardDetail {
  const card = cardFor(scene);
  return {
    ...reviewDetail, card, sessions: [], reports: [], questions: [questionFor[scene]],
    comments: [
      { id: 'c1', cardId: card.id, authorKind: 'agent', authorId: 'roselin', sessionId: null, kind: 'comment', body: '실행 명령에 실린 값을 세어 1번 항목에 적었습니다.', createdAt: at(8) },
      ...threadFor[scene],
    ],
  };
}

function entryFor(scene: CardQuestionScene, detail: CardDetail): PersistentReportEntry & { card_id: string; card_status: string } {
  const question = detail.questions[0]!;
  const answered = question.answer !== null;
  return {
    key: `cq_${question.id}`, kind: 'ask', title: question.title ?? detail.card.title, card_numbers: [detail.card.number ?? 1132],
    context: question.text, action: '', options: [], state: answered ? 'answered' : 'open', answer: question.answer ?? '',
    updated_at: at(20), card_id: detail.card.id, card_status: 'blocked', question_id: question.id,
    question_title: question.title ?? undefined, question_text: question.text, question_kind: question.kind ?? 'choice',
    question_option_details: question.optionDetails ?? (question.options ?? []).map(label => ({ label })),
    question_attachments: question.attachments ?? [], question_thread: threadFor[scene].map(comment => ({
      id: comment.id, question_id: question.id, author_kind: comment.authorKind, body: comment.body, created_at: comment.createdAt, session_id: null,
    })),
    question_revision: question.revision, question_revised_at: question.revisedAt,
  };
}

/** 질문 장과 함께 깔리는 판의 다른 장. 답이 저장되면 서버 판은 질문 장을 빼고 이 장을 남긴다. */
function cardSheetFor(detail: CardDetail): PersistentReportEntry {
  return {
    key: `card_${detail.card.id}`, kind: 'see', title: '카드에 답을 반영했습니다',
    card_numbers: [detail.card.number ?? 1132], context: '질문 장에서 정한 답을 카드에 적었습니다.', action: '', options: [],
    state: 'open', answer: '', updated_at: at(22), card_id: detail.card.id, card_status: 'blocked',
  };
}

function useScenePreset(scene: CardQuestionScene, surface: 'pas' | 'card', cardId: string, questionId: string, revision: number) {
  useEffect(() => {
    const draftKey = `composer:card-comment:${cardId}`;
    if (scene !== 'na') return;
    const scope = surface === 'card' ? cardDetailTargetScope(cardId) : pasSheetTargetScope(`cq_${questionId}`);
    setCardQuestionTarget(scope, { kind: 'append', questionId, label: '파일로 옮기기' });
    useDashboardStore.getState().setDraft(draftKey, '이대로, 열만 맞춰서');
    return () => {
      useDashboardStore.getState().clearDraft(draftKey);
    };
  }, [scene, surface, cardId, questionId, revision]);
}

export function CardQuestionReviewSample({ scene, surface, bubble = true, narrow = false }: {
  scene: CardQuestionScene; surface: 'pas' | 'card'; bubble?: boolean; narrow?: boolean;
}) {
  const [revision, setRevision] = useState(0);
  const detail = useMemo(() => detailFor(scene), [scene, revision]);
  const detailRef = useRef(detail);
  const cardId = detail.card.id;
  const question = detail.questions[0]!;
  const boardUpdate = useRef<((questionId: string) => void) | null>(null);
  useLayoutEffect(() => { detailRef.current = detail; }, [detail]);
  useCardApiSample(detailRef, questionId => boardUpdate.current?.(questionId));
  useEffect(() => {
    const store = useCardStore.getState();
    store.putCards([detail.card]);
    void store.loadCard(cardId).catch(() => undefined);
  }, [detail, cardId]);
  useScenePreset(scene, surface, cardId, question.id, revision);
  return surface === 'card'
    ? <div key={revision} style={{ width: '100%', maxWidth: 760, height: narrow ? 1800 : 1500, display: 'grid' }} data-testid="card-question-card-sample">
        <CardDetailPane cardId={cardId} folders={[]} onClose={() => {}} onOpenSession={() => {}} />
      </div>
    : <PasQuestionSample key={revision} scene={scene} detail={detail} bubble={bubble} boardUpdate={boardUpdate}
        onReset={() => { useDashboardStore.getState().setPendingChatSend(`card-question-review-${scene}`, null); setRevision(current => current + 1); }} />;
}

function PasQuestionSample({ scene, detail, bubble, boardUpdate, onReset }: {
  scene: CardQuestionScene; detail: CardDetail; bubble: boolean; boardUpdate: MutableRefObject<((questionId: string) => void) | null>; onReset(): void;
}) {
  const sessionId = `card-question-review-${scene}`;
  const entry = entryFor(scene, detail);
  const [board, setBoard] = useState<PersistentReportEntry[]>(() => [entry, cardSheetFor(detail)]);
  const removeQuestion = useCallback((questionId: string) => {
    flushSync(() => setBoard(current => current.filter(item => item.key !== `cq_${questionId}`)));
  }, []);
  useLayoutEffect(() => { boardUpdate.current = removeQuestion; return () => { boardUpdate.current = null; }; }, [boardUpdate, removeQuestion]);
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const layout = calculatePersistentSessionLayout({ app: { left: 0, top: 0, width: 1440, height: 900 }, header: { left: 0, top: 0, width: 1440, height: 76 }, main: { left: 460, top: 76, width: 520, height: 792 }, baselineBottom: 868, inputRowHeight: 32, rowBottomGap: 4, pointerFine: true, showCharacter: true, phoneConfigured: false, reportBubble: { widthScale: 0.8, minimumHeight: REPORT_BUBBLE_MINIMUM_HEIGHT } });
  const seat: ReportBubbleSeat = { target, layout: layout.reportBubble, body: layout.body };
  const deck = <PersistentReportDeck sessionId={sessionId} seat={bubble ? seat : undefined} notify={() => {}} focusInput={() => {}} dismissReport={async () => {}}
    transport={async ({ contextItems }) => {
      // 서버는 답을 저장한 커밋 뒤 판을 다시 계산해 보낸다. 표본도 판 교체를 먼저 그리고 답 확인을 돌려준다.
      const key = contextItems?.find(item => item.key === 'persistent_report_reply')?.content.key;
      if (typeof key === 'string' && key.startsWith('cq_')) removeQuestion(key.slice('cq_'.length));
      return { ok: true, delivered: true, reason: null, consumeWhen: null };
    }}
    renderCardStatus={item => <PasCardExpansionStatus entry={item} />}
    renderQuestion={pasCardQuestion}
    renderCardDetails={(item, lookupCards) => <PasCardExpansion key={item.key} entry={item} lookupCards={lookupCards} samplePortraitUrl="/system-portrait.png" />} />;
  return <>
    <PersistentReportProvider sessionId={sessionId} entries={board}>
      <div className="persistent-session-screen" data-scene={scene} data-board={board.map(item => item.key).join(',')}>
        {bubble ? <div style={{ position: 'relative', height: layout.reportBubble!.maxHeight, width: layout.reportBubble!.width }}>
          <div ref={setTarget} className="persistent-session-character" style={{ left: layout.body!.left - layout.reportBubble!.left, top: layout.reportBubble!.maxHeight + layout.body!.top - layout.reportBubble!.bottom, width: layout.body!.width }} />
          {deck}
        </div> : <main className="persistent-session-main" style={{ height: 'auto' }}>{deck}</main>}
      </div>
    </PersistentReportProvider>
    <button type="button" onClick={onReset}>초기화</button>
  </>;
}

/** 질문 장 부품만 운영 보기 모델로 그린 표본: 선택 질문(글타래·기다림)과 부탁 장. */
export function CardQuestionPartsSample() {
  const choice = cardQuestionDetailView(threadQuestion, threadFor.da, cardFor('da').title);
  const request = cardQuestionDetailView(requestQuestion, [], cardFor('ra').title);
  return <div className="v3-components-samples" style={{ width: 520 }}>
    <div className="v3-card-question-body">
      {choice.title ? <h3 className="v3-card-question-title">{choice.title}</h3> : null}
      <CardQuestionBody view={choice} portraitUrl={null} userPortraitUrl={null} onChoose={() => {}} />
      <CardQuestionActions view={choice} onAnswerFreely={() => {}} onAskBack={() => {}} composerVisible />
      <CardQuestionAnswered view={{ ...choice, open: false, answer: '파일로 옮기기', selectedOption: '파일로 옮기기' }} onAppend={() => {}} />
    </div>
    <div className="v3-card-question-body">
      {request.title ? <h3 className="v3-card-question-title">{request.title}</h3> : null}
      <CardQuestionBody view={request} portraitUrl={null} userPortraitUrl={null} onChoose={() => {}} />
      <CardQuestionActions view={request} onAnswerFreely={() => {}} onAskBack={() => {}} onDone={() => {}} />
    </div>
  </div>;
}
