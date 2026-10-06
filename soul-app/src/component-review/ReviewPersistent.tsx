import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ApiClient } from '../api/client';
import type { CardCheckItem, CardDetail, CardDto, CardStatus } from '../api/cardTypes';
import { CardDetailContent } from '../components/planner/CardDetailSheet';
import { CardRow } from '../components/planner/CardRow';
import { PersistentSessionTaskList } from '../components/persistent/PersistentSessionTaskList';
import { SwayCharacter } from '../components/persistent/SwayCharacter';
import { makeCard, createReviewApi } from './fixtures';
import { ReviewSection } from './ReviewSection';
import { useTokens } from '../theme';

const reviewTime = '2026-10-05T00:00:00Z';

function reviewItem(id: number, result: string): CardCheckItem {
  return { id, title: `항목 ${id}`, state: 'done', result, evidence: [], caveat: null, rev: 1, confirmed: null,
    fixOpen: 0, reopened: null, from: null, createdAt: reviewTime, reportedAt: reviewTime, display: 'reported' };
}

function reviewCard(status: CardStatus, id: string, number: number | null, title: string, request: string): CardDto {
  return { ...makeCard(status), id, number, title, request, assigneeKind: 'agent', assigneeAgentId: '로젤린',
    assigneeSessionId: null, nodeId: null, items: [], now: null };
}

const taskCards: CardDto[] = [
  reviewCard('running', 'public-persistent-412', 412, '모바일 흐름 확인', '첫 화면에서 한 문장을 남기면 다음 흐름까지 끊기지 않게 이어 줘.'),
  reviewCard('running', 'public-persistent-415', 415, '첫 진입 화면에서도 이어 쓰는 흐름 정리', '작은 화면에서 입력창이 늘어나도 대화가 끊기지 않는지 확인합니다.'),
  reviewCard('blocked', 'public-persistent-409', 409, '테스트 계정 확인', '검토에 사용할 공개 예시 계정을 확인합니다.'),
  reviewCard('review', 'public-persistent-404', 404, '온보딩 시안 검토', '온보딩 화면을 공개 fixture로 검토합니다.'),
  reviewCard('queued', 'public-persistent-417', 417, '접근성 점검', '대기열의 카드도 전체 작업 목록에 남습니다.'),
  reviewCard('todo', 'public-persistent-418', 418, '다음 실험 메모', '아직 실행하지 않은 드래프트 카드입니다.'),
  reviewCard('todo', 'public-persistent-old', null, '번호 없는 예전 카드', '옛 카드에는 번호가 없을 수 있습니다.'),
];
const mixedNumberCards: CardDto[] = [7, 98, 412, 1024].map((number) => reviewCard('running', `public-persistent-mixed-${number}`,
  number, '접근성 점검', '번호 열의 시작선을 확인합니다.'));

const summaryCard = { ...taskCards[0], title: '모바일 흐름 확인', now: {
  text: '첫 화면에서 남긴 한 문장이 다음 흐름까지 자연스럽게 이어지는지 살펴보는 일입니다.',
  turn: 'agent' as const, ask: null, updatedAt: reviewTime, sessionId: 'public-persistent-session',
}, items: [
  reviewItem(1, '작은 화면에서 입력창이 늘어나는 동작을 확인했습니다'),
  reviewItem(2, '첨부를 열고 닫아도 읽던 자리가 유지됩니다'),
  reviewItem(3, '가로 화면 확인이 남았습니다'),
], attachments: [{ nodeId: 'eiaserinnys', path: 'cards/public-persistent-412/screen-notes.pdf',
  name: '화면 설계.pdf', mimeType: 'application/pdf' }] };
const longCard = { ...summaryCard, id: 'public-persistent-long', number: 415,
  title: '첫 진입 화면에서도 이어 쓰는 흐름이 끊기지 않도록 입력창과 대화 위치, 첨부 복귀까지 확인하는 아주 긴 카드 제목입니다',
  request: '첫 화면에서 남긴 한 문장이 다음 흐름까지 끊기지 않게 이어지는지 확인합니다. 좁은 화면에서 입력창이 늘어날 때 목록과 대화 위치가 유지되는지 살펴봅니다. 첨부 미리보기를 열고 닫은 뒤에도 작성 내용과 읽던 자리가 남는지 확인해 주세요. 뒤로 돌아온 뒤 대화가 이어지고, 작업 카드의 요청과 경과가 같은 내용을 가리키는지도 점검합니다.' };
const noProgressCard = { ...summaryCard, id: 'public-persistent-no-progress', number: 418,
  title: '진행 내용이 없는 카드', now: null, items: [] };
const sparseCard = { ...summaryCard, id: 'public-persistent-sparse', number: null,
  title: '요청과 경과가 없는 번호 없는 카드', request: '', attachments: [], now: null, items: [] };
const realisticCard = { ...summaryCard, id: 'public-persistent-realistic', number: 130,
  title: '영구 관제 세션', attachments: [],
  request: '수퍼바이저 세션을 영구 세션으로 바꾸고 싶어. 지금은 세션이 길어지면 새 세션으로 넘어가면서 맥락이 끊겨. 컨텍스트가 차면 스스로 세대를 넘기되 내가 하던 말은 이어서 알아야 해. 유휴 시간의 캐시 비용을 줄일 방법과 계정 두 개의 사용량을 어떻게 나눌지도 함께 살펴봐 줘. 전화면으로 대화만 보는 모드도 있으면 좋겠어. 왼쪽에 캐릭터가 서 있고 가운데에 대화가 원고처럼 흐르는 모양으로 작업 목록은 오른쪽에서 열고 닫을 수 있게 해 줘. 이번 작업에서는 요청이 유지되는지, 작은 화면에서 위치가 보존되는지, 첨부를 열고 돌아와도 작성 내용이 남는지 확인해 줘. 급하지는 않지만 이번 주 안에 방향을 잡고 싶어.',
  items: [reviewItem(1, '설계 문서와 채택 결정을 읽고 화면별 구현 순서를 확정했습니다'),
    reviewItem(2, '웹과 앱의 원고형 대화 변형을 작업 항목에 맞춰 머지했습니다'),
    reviewItem(3, '캐릭터 동작과 배치가 웹과 앱 양쪽에서 맞는지 확인했습니다'),
    reviewItem(4, '턴이 끝날 때 표시하는 사용량 줄을 화면 기준에 맞게 보완했습니다'),
    reviewItem(5, '작업 목록과 카드 읽기 요약을 좁은 폭에서 다시 검수하고 있습니다'),
    reviewItem(6, '설정창과 사용량 모니터링 동작의 남은 항목을 구현하고 있습니다'),
    reviewItem(7, '화면 틀을 연결하고 기존 카드 상세로 이어지는 경로를 확인해야 합니다')] };
const twoImageCard = { ...realisticCard, id: 'public-persistent-two-images', number: 131, title: '이미지 둘이 있는 카드',
  request: '첨부한 화면 둘을 확인하고 결과를 정리해 주세요.',
  attachments: [
    { nodeId: 'eiaserinnys', path: 'cards/public-persistent-realistic/screen-one.png', name: '첫 화면', mimeType: 'image/png' },
    { nodeId: 'eiaserinnys', path: 'cards/public-persistent-realistic/screen-two.png', name: '둘째 화면', mimeType: 'image/png' },
  ] };
const blankParagraphCard = { ...realisticCard, id: 'public-persistent-blank-paragraphs', number: 132, title: '문단이 나뉜 긴 요청',
  request: `${'첫 문단에서 화면 흐름과 작은 화면의 상태를 확인해 주세요. '.repeat(5)}\n\n${'둘째 문단에서 첨부 복귀와 작성 위치가 보존되는지도 확인해 주세요. '.repeat(5)}` };
const sessionNullLabelCard = { ...summaryCard, id: 'public-persistent-session-null-label', number: 131,
  assigneeKind: 'session' as const, assigneeSessionId: 'public-session-null-label', assigneeAgentId: null };
const sessionNullLabel = { agentSessionId: 'public-session-null-label', displayName: null, status: 'idle', createdAt: reviewTime,
  updatedAt: reviewTime, agentName: null, agentId: null, agentPortraitUrl: null };
const sessionNamedCard = { ...summaryCard, id: 'public-persistent-session-named', number: 133,
  assigneeKind: 'session' as const, assigneeSessionId: 'public-session-named', assigneeAgentId: null };
const sessionNamed = { agentSessionId: 'public-session-named', displayName: '로젤린', status: 'idle', createdAt: reviewTime,
  updatedAt: reviewTime, agentName: '로젤린', agentId: 'roselin', agentPortraitUrl: null };

const detailCards = [summaryCard, longCard, noProgressCard, sparseCard, realisticCard, twoImageCard, blankParagraphCard,
  sessionNullLabelCard, sessionNamedCard];

function createPersistentReviewApi(state: string | null): ApiClient {
  const base = createReviewApi();
  return {
    ...base,
    listCards: async () => {
      if (state === 'list-error') throw new Error('Request failed with status 503');
      if (state === 'list-loading') return new Promise<never>(() => {});
      if (state === 'empty') return { cards: [] };
      if (state === 'mixed-numbers') return { cards: mixedNumberCards };
      return { cards: taskCards };
    },
    getCard: async (id) => {
      if (state === 'card-error') throw new Error('Request failed with status 503');
      if (state === 'card-loading') return new Promise<never>(() => {});
      const card = detailCards.find((entry) => entry.id === id) ?? taskCards.find((entry) => entry.id === id) ?? summaryCard;
      const detail: CardDetail = { card, reports: [], comments: [], questions: [],
        sessions: card.id === sessionNullLabelCard.id ? [sessionNullLabel]
          : card.id === sessionNamedCard.id ? [sessionNamed] : [] };
      return detail;
    },
  } as ApiClient;
}

function CharacterSample({ label, width, height, motionEnabled, shown = true }: {
  label: string; width: number; height: number; motionEnabled: boolean; shown?: boolean;
}) {
  const t = useTokens();
  return <View style={{ alignItems: 'center', gap: t.spacing.sm }}>
    <Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>{label}</Text>
    <View style={{ alignSelf: 'center' }}>
      <SwayCharacter width={width} height={height} shown={shown} motionEnabled={motionEnabled} active />
    </View>
  </View>;
}

function recordReviewOpen(cardId: string) {
  if (typeof window !== 'undefined') (window as Window & { __persistentReviewOpenedCard?: string }).__persistentReviewOpenedCard = cardId;
}

export function ReviewPersistent() {
  const t = useTokens();
  const query = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const sample = query.get('sample') ?? 'all';
  const detailCase = query.get('case') ?? 'summary';
  const state = query.get('state');
  const previewWidth = Number(query.get('width')) || undefined;
  const previewHeight = Number(query.get('height')) || undefined;
  const api = useMemo(() => createPersistentReviewApi(state), [state]);
  const selectedCard = detailCase === 'realistic' ? realisticCard : detailCase === 'two-images' ? twoImageCard
    : detailCase === 'blank-paragraphs' ? blankParagraphCard
      : detailCase === 'session-named' ? sessionNamedCard : detailCase === 'session-null-label' ? sessionNullLabelCard
    : detailCase === 'long' ? longCard : detailCase === 'no-progress' ? noProgressCard
      : detailCase === 'sparse' ? sparseCard : summaryCard;
  const paper = { flex: 1, minHeight: 0, backgroundColor: t.persistentSession.paper } as const;
  const detailPanel = { flex: 1, minHeight: 0, width: '100%' as const, alignSelf: 'stretch' as const,
    backgroundColor: t.persistentSession.panel, borderWidth: StyleSheet.hairlineWidth, borderColor: t.persistentSession.line,
    borderRadius: t.foundation.radius.panel, overflow: 'hidden' as const };
  const panelHeight = previewHeight ? { flexGrow: 0, flexShrink: 0, flexBasis: 'auto' as const, height: previewHeight } : undefined;
  const preview = <View testID="persistent-review-paper" style={paper}>
    {sample === 'list' ? <View style={{ width: previewWidth, alignSelf: previewWidth ? 'center' : 'stretch', flex: 1 }}>
      <PersistentSessionTaskList api={api} onOpenCard={recordReviewOpen} />
    </View> : null}
    {sample === 'row' ? <View style={{ width: previewWidth, alignSelf: previewWidth ? 'center' : 'stretch', flex: 1, justifyContent: 'center' }}>
      <CardRow api={api} card={summaryCard} variant="summary" onOpen={() => recordReviewOpen(summaryCard.id)} />
    </View> : null}
    {sample === 'card' ? <View testID="persistent-review-card-panel" style={[detailPanel, previewWidth ? { width: previewWidth, alignSelf: 'center' } : undefined, panelHeight]}>
      <CardDetailContent api={api} cardId={selectedCard.id} variant="readSummary" onOpenCard={() => recordReviewOpen(selectedCard.id)} onClose={() => {}} />
    </View> : null}
    {sample === 'all' ? <ScrollView testID="persistent-review-all" style={{ flex: 1 }} contentContainerStyle={{ padding: t.cardLayout.padding, gap: t.uiSpacing.xxl }}>
      <ReviewSection title="영구 세션 · 캐릭터 부품">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: t.spacing.xl }}>
          <CharacterSample label="가로 iPad · 움직임 켬" width={152} height={228} motionEnabled />
          <CharacterSample label="세로 iPad · 움직임 켬" width={126} height={189} motionEnabled />
          <CharacterSample label="움직임 끔" width={152} height={228} motionEnabled={false} />
          <CharacterSample label="표시 끔" width={152} height={228} motionEnabled shown={false} />
        </View>
      </ReviewSection>
      <ReviewSection title="작업 목록">
        <PersistentSessionTaskList api={api} onOpenCard={recordReviewOpen} />
      </ReviewSection>
      <ReviewSection title="요약 행">
        <CardRow api={api} card={summaryCard} variant="summary" onOpen={() => recordReviewOpen(summaryCard.id)} />
      </ReviewSection>
      <ReviewSection title="카드 읽기 요약">
        <View style={detailPanel}>
          <CardDetailContent api={api} cardId={summaryCard.id} variant="readSummary" onOpenCard={() => recordReviewOpen(summaryCard.id)} onClose={() => {}} />
        </View>
      </ReviewSection>
    </ScrollView> : null}
  </View>;

  if (sample !== 'all') return <View style={[paper, { padding: t.cardLayout.padding }]}>
    <ReviewSection title={sample === 'list' ? '작업 목록' : sample === 'row' ? '요약 행' : '카드 읽기 요약'}>
      <View style={{ flex: 1, minHeight: 0 }}>{preview}</View>
    </ReviewSection>
  </View>;
  return preview;
}
