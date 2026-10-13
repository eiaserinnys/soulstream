import type { ApiClient } from '../api/client';
import type { CardDto } from '../api/cardTypes';
import type { Session } from '../api/types';
import type { UsageSummaryNode, UsageSummaryProvider, UsageSummarySnapshot } from '../../../packages/soul-ui/src/lib/usage-summary';
import { nativeSettingsReviewApi } from './native-settings-fixtures';
import { createPersistentReviewApi, persistentReviewCards } from './persistent-review-fixtures';
import { dialogueImageUrl } from './dialogue-fixtures';
import { dialogueMessages, reviewSessionEventsUrl } from './chat-fixtures';

const reviewUsageResetAt = Math.floor(Date.now() / 1000) + 4 * 24 * 60 * 60 + 2 * 60 * 60;
const reviewUsageProvider = (weeklyRemainingPercent: number, quotas: UsageSummaryProvider['quotas'] = []): UsageSummaryProvider => ({
  status: 'auto', weeklyRemainingPercent, weeklyResetAt: reviewUsageResetAt,
  shortRemainingPercent: null, shortResetAt: null, quotas,
});
const reviewUsageNode = (nodeId: string, providers: UsageSummaryNode['providers']): UsageSummaryNode => ({
  nodeId, fetchedAt: '2026-10-13T08:00:00.000Z', stale: false, staleSince: null, providers,
});
export const persistentWeeklyUsageReviewSummary: UsageSummarySnapshot = {
  generatedAt: '2026-10-13T08:00:00.000Z',
  collectedAt: null,
  nodes: [
    reviewUsageNode('node-a', {
      claude: reviewUsageProvider(73, [{ id: 'claude:weekly_scoped:fable', label: 'Fable', window: '7d', model: 'Fable', remainingPercent: 41, resetAt: reviewUsageResetAt }]),
      codex: reviewUsageProvider(18),
      gemini: null,
    }),
    reviewUsageNode('node-b', { claude: reviewUsageProvider(66), codex: reviewUsageProvider(42), gemini: null }),
    reviewUsageNode('node-c', { claude: null, codex: null, gemini: null }),
  ],
};

const usageReviewTaskGroups = [
  ['running', 201],
  ['review', 202],
  ['queued', 203],
  ['blocked', 204],
] as const;

function createUsageReviewCards(cards: CardDto[]): CardDto[] {
  return usageReviewTaskGroups.flatMap(([status, firstNumber]) => {
    const template = cards.find(card => card.status === status);
    if (!template) return [];
    return Array.from({ length: 6 }, (_, index) => {
      const number = firstNumber + index * 4;
      const position = String(index).padStart(4, '0');
      return { ...template, id: `public-pas-usage-${status}-${index + 1}`, number,
        title: `모의 작업 ${index + 1}`, positionKey: position, queuePositionKey: position };
    });
  });
}

export function createPersistentFullscreenReviewApi(search: string): ApiClient {
  const query = new URLSearchParams(search);
  const usageSample = query.get('sample') === 'usage';
  const usageState = query.get('usageState');
  const base = createPersistentReviewApi(query.get('state'));
  const cardOverlaySample = query.get('sample') === 'card-overlay';
  const cardOverlayCard = { ...persistentReviewCards.realisticCard,
    assigneeKind: 'session' as const, assigneeSessionId: 'review-pas-2', assigneeAgentId: null };
  const history = query.get('history') === 'long' ? Array.from({ length: 40 }, (_, index) => ({
    ...dialogueMessages[index % dialogueMessages.length], id: 40 - index, parent_event_id: null,
    payload: { text: `공개 대화 ${40 - index}: 카드 상세를 다녀온 뒤에도 읽던 위치를 확인합니다.` },
  })) : dialogueMessages;
  return {
    ...base, ...nativeSettingsReviewApi,
    listCards: usageSample ? async () => {
      const { cards } = await base.listCards();
      return { cards: createUsageReviewCards(cards) };
    } : cardOverlaySample ? async () => ({ cards: [cardOverlayCard] }) : base.listCards,
    getCard: async id => {
      if (cardOverlaySample && id === cardOverlayCard.id) {
        const detail = await base.getCard(id);
        const assignedSession: Session = { agentSessionId: 'review-pas-2', displayName: '로젤린', status: 'idle',
          nodeId: 'public-node', agentId: 'public-agent', agentName: '로젤린', agentPortraitUrl: dialogueImageUrl(),
          sessionType: 'interactive', createdAt: '2026-10-06T01:00:00Z', updatedAt: '2026-10-06T01:00:00Z' };
        return { ...detail, card: cardOverlayCard, sessions: [assignedSession] };
      }
      const detail = await base.getCard(query.get('case') === 'long' ? persistentReviewCards.blankParagraphCard.id : id);
      return query.get('case') === 'long' ? { ...detail, card: { ...detail.card, id } } : detail;
    },
    listPersistentSessions: async () => {
      if (query.get('state') === 'entry-loading') return new Promise<never>(() => {});
      const result = await nativeSettingsReviewApi.listPersistentSessions();
      const count = query.get('count');
      const listed = count === null ? result.sessions.slice(0, 1) : result.sessions.slice(0, Number(count));
      const sessions = usageSample ? listed.map((session, index) => index === 0
        ? { ...session, node_id: 'node-a', agent_name: '서소영 (PAS)' }
        : session) : listed;
      return { ...result, sessions, total: sessions.length };
    },
    getPersistentSession: async (id: string) => {
      const result = await nativeSettingsReviewApi.getPersistentSession(id);
      return usageSample && id === 'review-pas-1'
        ? { ...result, session: { ...result.session, node_id: 'node-a', agent_name: '서소영 (PAS)' } }
        : result;
    },
    getUsageSummary: async () => {
      if (usageState === 'loading') return new Promise<never>(() => {});
      if (usageState === 'error') throw new Error('공개 예시: 주간 사용량을 불러오지 못했습니다.');
      if (usageState === 'pending') return { ...persistentWeeklyUsageReviewSummary, nodes: [] };
      return persistentWeeklyUsageReviewSummary;
    },
    getSessionsByIds: async (ids: readonly string[]) => Promise.all(ids.map(async id => {
      if (!id.startsWith('review-pas-')) return (await nativeSettingsReviewApi.getSessionsByIds([id]))[0];
      const { session } = await nativeSettingsReviewApi.getPersistentSession(id);
      return { agentSessionId: id, displayName: session.display_name, status: 'idle', nodeId: session.node_id,
        agentId: session.agent_id, agentName: session.agent_name, agentPortraitUrl: dialogueImageUrl(),
        modelPreset: session.runtime.current_model.model_preset, sessionType: 'interactive',
        createdAt: '2026-10-06T01:00:00Z', updatedAt: '2026-10-06T01:00:00Z' } as Session;
    })),
    getTimeline: async (id, params) => params?.eventTypes?.includes('user_message')
      ? { messages: params?.before ? [] : history, next_cursor: null }
      : nativeSettingsReviewApi.getTimeline(id, params),
    ...(query.has('runtime') ? {
      listClaudeBackgroundTasks: async (sessionId: string) => {
        const response = await nativeSettingsReviewApi.listClaudeBackgroundTasks(sessionId);
        return { ...response, tasks: query.get('runtime') === 'none' ? [] : response.tasks };
      },
      listClaudeSchedules: async (sessionId: string) => ({ sessionId, nextRunAt: null, schedules: [] }),
    } : {}),
    sessionEventsUrl: reviewSessionEventsUrl,
  } as ApiClient;
}
