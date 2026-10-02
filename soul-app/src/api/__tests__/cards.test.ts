import { createApiClient } from '../client';
import { useAuthStore } from '../../store/authStore';

// serializeCardRow/getToday response shape. No snake_case card/session keys.
export const cardFixture = {
  id: 'card/1', folderId: 'folder-1', title: '앱 카드', request: '요청 원문', brief: '# 경과',
  status: 'review', positionKey: 'a0', queuePositionKey: null,
  blockedKind: null, blockedDetail: null, assigneeKind: 'agent', assigneeAgentId: 'roselin',
  assigneeSessionId: null, assigneeUserId: null, nodeId: 'node-1', modelPreset: 'sol',
  archived: false, version: 3, createdAt: '2026-09-30T00:00:00Z', updatedAt: '2026-09-30T01:00:00Z',
};
const session = { sessionId: 'session-1', cardId: 'card/1', displayName: '실행 세션',
  nodeId: 'node-1', agentId: 'roselin', status: 'completed', createdAt: '' };
const detail = { card: cardFixture,
  reports: [{ id: 'report-1', cardId: 'card/1', title: '완료 보고', format: 'html', body: '<p>보고</p>', createdAt: '' }],
  questions: [{ id: 'question/1', cardId: 'card/1', sessionId: 'session-1', text: '확인?', options: ['네'], answer: null, askedAt: '' }],
  sessions: [session] };
const response = (body: unknown) => ({ ok: true, status: 200, headers: new Headers({ 'Content-Type': 'application/json' }),
  json: async () => body, text: async () => JSON.stringify(body) } as Response);
beforeEach(() => useAuthStore.setState({ jwt: 'test-jwt' }));
afterEach(() => jest.restoreAllMocks());
test('active and completed queries retain separate contracts', async () => {
  const fetch=jest.spyOn(global,'fetch').mockResolvedValue(response({cards:[],nextCursor:null}));
  const api=createApiClient('https://cards.test');
  await api.listCards('folder-1',{includeCompleted:false});
  await api.listCompletedCards({folderId:'folder-1',q:'요청',limit:60,cursor:'next'});
  expect(String(fetch.mock.calls[0][0])).toContain('includeCompleted=false');
  const query=new URL(String(fetch.mock.calls[1][0])).searchParams;
  expect(Object.fromEntries(query)).toEqual({status:'done',folderId:'folder-1',q:'요청',limit:'60',cursor:'next'});
});

test('aggregate and snapshot exclude done with an explicit false query while omitted keeps compatibility',async()=>{
  const fetch=jest.spyOn(global,'fetch').mockResolvedValue(response({folder:{id:'folder-1'},page:{id:'page',title:'폴더',daily_date:null,version:1,archived:false,metadata:{},created_at:'',updated_at:''},blocks:[],cards:[],subfolders:{items:[],nextCursor:null},sessions:{items:[],nextCursor:null}}));
  const api=createApiClient('https://cards.test');
  await api.getFolderSnapshot('folder-1',{includeCompleted:false});
  await api.getPlannerFolder('folder-1',{includeCompleted:false});
  await api.getPlannerFolder('folder-1');
  expect(fetch.mock.calls.map(([url])=>url)).toEqual(['https://cards.test/api/folders/folder-1?includeCompleted=false','https://cards.test/api/planner/folders/folder-1?includeCompleted=false','https://cards.test/api/planner/folders/folder-1']);
});

test('카드 상세/목록은 서버 camelCase 행과 세션 연결을 보존한다', async () => {
  const fetch = jest.spyOn(global, 'fetch').mockResolvedValueOnce(response(detail))
    .mockResolvedValueOnce(response({ cards: [cardFixture] }));
  const api = createApiClient('https://cards.test');
  const result = await api.getCard('card/1');
  expect(result).toMatchObject(detail);
  expect(result.sessions[0].agentSessionId).toBe('session-1');
  expect(await api.listCards('folder-1')).toEqual({ cards: [cardFixture] });
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    'https://cards.test/api/cards/card%2F1', 'https://cards.test/api/cards?folderId=folder-1',
  ]);
});

test('생성·완료·반려·대기·빼기·취소·이동·순서·담당·답변은 서버 계약대로 보낸다', async () => {
  const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(response({ card: cardFixture, folderId: 'folder-1' }));
  const api = createApiClient('https://cards.test');
  await api.createCard({ folderId: 'folder-1', title: '요청', request: '요청', queue: true,
    assignee: { kind: 'agent', agentId: 'roselin' }, nodeId: 'node-1', modelPreset: 'sol', idempotencyKey: 'create',
    attachments: [{ nodeId: 'node-1', path: '/uploaded/사진.png', name: '사진.png', mimeType: 'image/png' }] });
  for (const status of ['done', 'running', 'queued', 'todo', 'cancelled'] as const) {
    await api.setCardStatus('card/1', status, 3, `status-${status}`, status === 'running' ? '반려 사유' : undefined);
  }
  await api.moveCard('card/1', 'folder-2', 3, 'move');
  await api.reorderCardQueue('card/1', null, 3, 'order');
  await api.updateCard('card/1', { assignee: { kind: 'agent', agentId: 'ariella' }, nodeId: 'node-2', modelPreset: null }, 3, 'assignment');
  await api.answerCardQuestion('card/1', 'question/1', '네', 'answer');
  const calls = fetch.mock.calls.map(([url, init]) => ({ url, method: init?.method, body: JSON.parse(init?.body as string) }));
  expect(calls[0]).toMatchObject({ method: 'POST', body: { queue: true, folderId: 'folder-1', nodeId: 'node-1' } });
  expect(calls[0].body.attachments).toEqual([{ nodeId: 'node-1', path: '/uploaded/사진.png', name: '사진.png', mimeType: 'image/png' }]);
  expect(calls.slice(1, 6).map((c) => c.body.status)).toEqual(['done', 'running', 'queued', 'todo', 'cancelled']);
  expect(calls[2].body).toEqual({ status: 'running', expectedVersion: 3, idempotencyKey: 'status-running', reason: '반려 사유' });
  expect(calls[6].body).toEqual({ folderId: 'folder-2', expectedVersion: 3, idempotencyKey: 'move' });
  expect(calls[7]).toMatchObject({ url: 'https://cards.test/api/cards/card%2F1/queue-position', body: { afterCardId: null, expectedVersion: 3 } });
  expect(calls[8]).toMatchObject({ method: 'PATCH', body: { modelPreset: null, assignee: { agentId: 'ariella' } } });
  expect(calls[9]).toEqual({ url: 'https://cards.test/api/cards/card%2F1/questions/question%2F1/answer', method: 'POST', body: { answer: '네', idempotencyKey: 'answer' } });
});

test('오늘 파서는 attention/running/queued와 메모를 함께 보존한다', async () => {
  jest.spyOn(global, 'fetch').mockResolvedValue(response({
    daily: { page: { id: 'daily', title: '', daily_date: '2026-09-30', version: 1, archived: false,
      metadata: {}, created_at: '', updated_at: '' }, blocks: [], state_vector: '' },
    memoBlocks: [], folders: [], reviewSessionIds: [], attention: [cardFixture], running: [], queued: [],
  }));
  const result = await createApiClient('https://cards.test').getPlannerToday('2026-09-30');
  expect(result.attention).toEqual([cardFixture]);
  expect(result.running).toEqual([]);
  expect(result.queued).toEqual([]);
  expect(result.memoBlocks).toEqual([]);
});

test('카드 세션의 실제 updatedAt과 callerSessionId를 보존하고 구버전 응답도 읽는다', async () => {
  jest.spyOn(global, 'fetch').mockResolvedValue(response({ ...detail, sessions: [
    { ...session, createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-30T01:00:00Z', callerSessionId: 'parent' },
    session,
  ] }));
  const result = await createApiClient('https://cards.test').getCard('card/1');
  expect(result.sessions[0]).toMatchObject({ updatedAt: '2026-09-30T01:00:00Z', callerSessionId: 'parent' });
  expect(result.sessions[1]).toMatchObject({ updatedAt: session.createdAt });
});

test('커멘트는 카드 comments wire를 보존하고 동일 키와 본문을 POST한다', async () => {
  const comment = { id: 'comment-1', cardId: cardFixture.id, authorKind: 'user', authorId: 'user', sessionId: null, kind: 'comment', body: '커멘트', createdAt: '2026-09-30T03:00:00Z' };
  const fetch = jest.spyOn(global, 'fetch').mockResolvedValueOnce(response({ ...detail, comments: [comment] })).mockResolvedValueOnce(response(comment));
  const api = createApiClient('https://cards.test');
  expect((await api.getCard(cardFixture.id)).comments).toEqual([comment]);
  expect(await api.addCardComment(cardFixture.id, { body: '커멘트', idempotencyKey: 'comment-key' })).toEqual(comment);
  const [url, init] = fetch.mock.calls[1];
  expect(url).toBe('https://cards.test/api/cards/card%2F1/comments');
  expect(init?.method).toBe('POST');
  expect(JSON.parse(init?.body as string)).toEqual({ body: '커멘트', idempotencyKey: 'comment-key' });
});
