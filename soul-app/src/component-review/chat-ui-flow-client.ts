import type { ApiClient } from '../api/client';
import { createPersistentFullscreenReviewApi } from './persistent-fullscreen-fixtures';
import { chatUiReviewHistory, chatUiReviewSession, chatUiReviewSessionId, chatUiReviewSseUrl } from './chat-ui-flow-fixtures';

export function createChatUiFlowReviewApi(search: string): ApiClient {
  const base = createPersistentFullscreenReviewApi(search);
  const params = new URLSearchParams(search);
  return {
    ...base,
    getSessionsByIds: async ids => ids.map(id => chatUiReviewSession(id)),
    getTimeline: async (_id, query) => {
      const history = chatUiReviewHistory(search).filter(event => !query?.before || event.id < Number(query.before));
      const visible = params.get('sample') === 'sse' ? history.filter(event => event.id !== 15) : history;
      const messages = visible.slice(0, query?.limit ?? 100);
      return { messages, next_cursor: visible.length > messages.length ? String(messages.at(-1)!.id) : null };
    },
    sessionEventsUrl: (id, lastId) => chatUiReviewSseUrl(id, search, lastId),
    getPersistentSession: async id => ({ session: {
      session_id: id, node_id: 'public-node', agent_id: 'public-agent', agent_name: 'Assistant',
      display_name: '채팅 UI', folder_id: null, persistent: params.get('presentation') === 'manuscript',
      settings: { default_model: { model_preset: null, reasoning_effort: null }, turn_usage_mode: 'collapsed' },
      runtime: { current_model: { model_preset: null, reasoning_effort: null, model: null }, pending: null },
    } }),
    listPersistentSessions: async () => ({ sessions: [{ session_id: chatUiReviewSessionId, node_id: 'public-node',
      display_name: '채팅 UI', agent_id: 'public-agent', agent_name: 'Assistant' }], total: 1 }),
  } as ApiClient;
}
