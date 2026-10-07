import type { ApiClient } from '../api/client';
import type { Session } from '../api/types';
import { nativeSettingsReviewApi } from './native-settings-fixtures';
import { createPersistentReviewApi, persistentReviewCards } from './persistent-review-fixtures';
import { dialogueImageUrl } from './dialogue-fixtures';
import { dialogueMessages, reviewSessionEventsUrl } from './chat-fixtures';

export function createPersistentFullscreenReviewApi(search: string): ApiClient {
  const query = new URLSearchParams(search);
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
    listCards: cardOverlaySample ? async () => ({ cards: [cardOverlayCard] }) : base.listCards,
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
      const sessions = count === null ? result.sessions.slice(0, 1) : result.sessions.slice(0, Number(count));
      return { ...result, sessions, total: sessions.length };
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
