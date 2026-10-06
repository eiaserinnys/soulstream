import type { ApiClient } from '../api/client';
import type { Session } from '../api/types';
import { nativeSettingsReviewApi } from './native-settings-fixtures';
import { createPersistentReviewApi } from './persistent-review-fixtures';
import { dialogueImageUrl } from './dialogue-fixtures';
import { dialogueMessages, reviewSessionEventsUrl } from './chat-fixtures';

export function createPersistentFullscreenReviewApi(search: string): ApiClient {
  const query = new URLSearchParams(search);
  const base = createPersistentReviewApi(query.get('state'));
  const history = query.get('history') === 'long' ? Array.from({ length: 40 }, (_, index) => ({
    ...dialogueMessages[index % dialogueMessages.length], id: 40 - index, parent_event_id: null,
    payload: { text: `공개 대화 ${40 - index}: 카드 상세를 다녀온 뒤에도 읽던 위치를 확인합니다.` },
  })) : dialogueMessages;
  return {
    ...base, ...nativeSettingsReviewApi,
    listCards: base.listCards, getCard: base.getCard,
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
    sessionEventsUrl: reviewSessionEventsUrl,
  } as ApiClient;
}
