import type { HistoricalMessage } from '../api/historyTypes';
import type { ApiClient } from '../api/client';
import type { PlannerFolder, PlannerSessionSummary } from '../api/plannerTypes';
import type { Session, ClaudeRuntimeTaskOutputResponse } from '../api/types';
import type { CardDto } from '../api/cardTypes';
import { Asset } from 'expo-asset';
import { createPlannerMutationPort } from '../api/plannerMutationPort';
import { createReviewApi, folders, sessions, starredFolders, message } from './fixtures';

export const dialogueFolders = folders.map(folder => ({ ...folder, projectPageId: folder.id === 'public-project' ? 'public-page' : 'public-child-page' }));
export const dialogueSessions = sessions.map((session): Session & PlannerSessionSummary => ({ ...session, folderId: 'public-project', nodeId: 'public-node', agentId: 'public-agent', modelPreset: 'public-model', predecessorSessionId: null, sessionType: 'interactive', reviewState: session.reviewState ?? 'not_required' }));
export const dialogueFolder: PlannerFolder = {
  ...starredFolders[0], page: { ...starredFolders[0].page, id: 'public-page' },
  projectPageId: 'public-page', folderSummary: { ...dialogueFolders[0], title: dialogueFolders[0].name, itemCounts: {}, itemTotal: 7, completedItemCount: 1, assignee: null },
  sessions: dialogueSessions, sessionIds: dialogueSessions.map(session => session.agentSessionId),
};
export const reviewTask = { taskId: 'public-task', status: 'completed' as const, updatedAt: 1, description: '공개 예시 작업 출력', summary: '메모리 예시 결과' };
export const reviewTaskOutput: ClaudeRuntimeTaskOutputResponse = {
  sessionId: 'public-idle', taskId: 'public-task', task: reviewTask,
  output: '공개 예시 작업 결과입니다. 운영 작업은 실행하지 않습니다.', outputAvailable: true, truncated: false,
};
export function dialogueImageUrl(): string | null {
  return typeof window !== 'undefined' && window.location?.origin
    ? new URL(Asset.fromModule(require('../../assets/icon.png')).uri, window.location.origin).href : null;
}
export function reviewSessionPortraits(items: typeof dialogueSessions) {
  return items.map(session => ({ ...session, agentPortraitUrl: dialogueImageUrl() }));
}
function withReviewSession(card: CardDto) {
  return card.assigneeAgentId === 'public-agent' ? { ...card, assigneeKind: 'session' as const, assigneeSessionId: 'public-idle' } : card;
}

const dialogueMessages: HistoricalMessage[] = [
  { id: 2, parent_event_id: 1, event_type: 'assistant_message',
    payload: message('assistant_message', '담당 세션의 대화입니다. 카드 요청과 입력창을 함께 확인할 수 있습니다.').data,
    created_at: '2026-10-03T16:00:01Z' },
  { id: 1, parent_event_id: null, event_type: 'user_message',
    payload: message('user_message', '이 카드의 담당 대화를 오른쪽에서 보여주세요.').data,
    created_at: '2026-10-03T16:00:00Z' },
];

// Explicit review transport. Methods operate on public in-memory data; there
// is no HTTP client, dynamic fallback, or production mutation behind this object.
export function createDialogueApi(): ApiClient {
  const base = createReviewApi();
  const catalogFolders = [...dialogueFolders];
  const catalogSessions = [...dialogueSessions];
  let sequence = 0;
  let token = false;
  const api = {
    ...base,
    listCards: async (...args: Parameters<ApiClient['listCards']>) => {
      const result = await base.listCards(...args);
      return { ...result, cards: result.cards.map(withReviewSession) };
    },
    getFolderSnapshot: async (...args: Parameters<ApiClient['getFolderSnapshot']>) => {
      const result = await base.getFolderSnapshot(...args);
      return { ...result, cards: result.cards.map(withReviewSession) };
    },
    getCard: async (id: string) => {
      const detail = await base.getCard(id);
      if (id !== 'public-todo') return { ...detail, card: withReviewSession(detail.card), sessions: reviewSessionPortraits(dialogueSessions) };
      return { ...detail, card: { ...detail.card, assigneeKind: 'session', assigneeSessionId: 'public-idle' },
        reports: [{ id: 'public-image-report', cardId: id, title: '공개 보고 이미지', format: 'markdown', createdAt: detail.card.createdAt,
          body: '공개 예시 상세입니다. 세로 스크롤과 이미지 확대를 확인합니다.\n\n' + '메모리에서만 사용하는 공개 예시 본문입니다.\n'.repeat(20) + '\n![공개 보고 이미지](' + dialogueImageUrl() + ')' }],
        sessions: reviewSessionPortraits(dialogueSessions) };
    },
    getCatalog: async () => ({ folders: catalogFolders, sessions: Object.fromEntries(reviewSessionPortraits(catalogSessions).map(item => [item.agentSessionId, item])), sessionList: reviewSessionPortraits(catalogSessions), total: catalogSessions.length }),
    getSessionsByIds: async (ids: readonly string[]) => reviewSessionPortraits(catalogSessions.filter(session => ids.includes(session.agentSessionId))),
    getPlannerFolder: async (id: string) => {
      const detail = await base.getPlannerFolder(id);
      return { ...detail, cards: detail.cards.map(withReviewSession), folder: catalogFolders.find(folder => folder.id === id) ?? dialogueFolders[0], sessions: { items: reviewSessionPortraits(catalogSessions), nextCursor: null } };
    },
    getPlannerFolderSessions: async () => ({ items: reviewSessionPortraits(catalogSessions), nextCursor: null }),
    getPlannerFolderSubfolders: async () => ({ items: [], nextCursor: null }),
    getStarredFolders: async () => ({ items: [dialogueFolder], nextCursor: null }),
    getDailyHistory: async () => ({ dates: ['2026-10-01'] }),
    getPlannerToday: async (date: string) => ({ ...(await base.getPlannerToday(date)), folders: date === '2026-10-01' ? [dialogueFolder] : [] }),
    createFolder: async (input: Parameters<ApiClient['createFolder']>[0]) => {
      const folder = { ...dialogueFolders[0], id: 'public-created-folder-' + ++sequence, name: input.name, parentFolderId: input.parentFolderId ?? null };
      catalogFolders.push(folder);
      return { folder };
    },
    createSession: async (input: Parameters<ApiClient['createSession']>[0]) => {
      const session = { ...dialogueSessions[2], agentSessionId: 'public-created-session-' + ++sequence, displayName: input.prompt, folderId: input.folderId ?? 'public-project' };
      catalogSessions.push(session);
      return { agentSessionId: session.agentSessionId };
    },
    applyPageOperations: async (id: string, input: Parameters<ApiClient['applyPageOperations']>[1]) => ({
      ...(await base.getPage(id)), page: { ...(await base.getPage(id)).page, version: input.expectedVersion + 1 },
      tempIdMapping: Object.fromEntries(input.operations.filter(op => op.op === 'create_block').map(op => [op.temp_id, 'public-anchor-' + ++sequence])),
    }),
    getDailyPage: async () => ({ page: dialogueFolder.page, created: false }),
    getPageBacklinks: async () => ({ items: [], nextCursor: null }),
    getTimeline: async (sessionId: string, params?: Parameters<ApiClient['getTimeline']>[1]) => ({
      messages: sessionId === 'public-idle' && !params?.before ? dialogueMessages : [], next_cursor: null,
    }),
    getMessages: async () => ({ messages: [], next_cursor: null }),
    getSessionStory: async () => null,
    getConfig: async () => ({ mode: 'orchestrator' as const }),
    getAuthStatus: async () => ({ authenticated: false, user: null }),
    getClaudeAuthStatus: async () => ({ has_token: token }),
    getClaudeProfile: async () => null,
    startClaudeAuth: async () => { throw new Error('공개 예시에서는 실제 계정 로그인을 시작하지 않습니다.'); },
    submitClaudeCode: async () => { token = true; return { ok: true }; },
    deleteClaudeToken: async () => { token = false; return { ok: true }; },
    getProviderUsage: async () => ({ generatedAt: new Date().toISOString(), providers: Object.fromEntries(['claude', 'codex', 'gemini'].map(provider => [provider, { status: 'not_configured', source: 'public-fixture', planType: null, quotas: [] }])) }),
    listRecurringJobs: async () => ({ jobs: [] }),
    listClaudeBackgroundTasks: async (sessionId: string) => ({ sessionId, sessionState: 'idle', runtimeSessionId: null, updatedAt: 1, tasks: [reviewTask] }),
    getClaudeBackgroundTaskOutput: async (sessionId: string, taskId: string) => ({ ...reviewTaskOutput, sessionId, taskId }),
    stopClaudeBackgroundTask: async (sessionId: string, taskId: string) => ({ sessionId, taskId, task: reviewTask, supported: true, stopped: true, alreadyTerminal: true }),
    listAtomRootNodes: async () => ({ nodes: [] }),
    listAtomNodeChildren: async () => ({ children: [] }),
    catalogStreamUrl: () => '', nodeStreamUrl: () => '', sessionEventsUrl: () => '',
  };
  const typed = api as unknown as ApiClient;
  return { ...typed, plannerMutations: createPlannerMutationPort(typed) };
}
export const dialogueApi = createDialogueApi();
