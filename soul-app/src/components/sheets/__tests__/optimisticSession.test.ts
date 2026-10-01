import {
  buildOptimisticSession,
  resolveOptimisticAgent,
} from '../optimisticSession';

describe('optimisticSession', () => {
  test('createSession 직후 running 세션과 에이전트 profile 필드를 만든다', () => {
    const session = buildOptimisticSession({
      agentSessionId: 'sess-1',
      prompt: '안녕',
      folderId: 'folder-1',
      nodeId: 'node-1',
      agent: {
        id: 'seosoyoung',
        name: '서소영',
        portraitUrl: '/api/nodes/node-1/agents/seosoyoung/portrait',
      },
      modelPreset: 'server-preset',
      now: '2026-05-19T12:00:00.000Z',
    });

    expect(session).toMatchObject({
      agentSessionId: 'sess-1',
      status: 'running',
      folderId: 'folder-1',
      nodeId: 'node-1',
      prompt: '안녕',
      agentId: 'seosoyoung',
      agentName: '서소영',
      agentPortraitUrl: '/api/nodes/node-1/agents/seosoyoung/portrait',
      modelPreset: 'server-preset',
      lastMessage: {
        type: 'user_message',
        preview: '안녕',
        timestamp: '2026-05-19T12:00:00.000Z',
      },
    });
  });

  test('자동 선택 + 에이전트 하나면 그 profile을 즉시 사용한다', () => {
    expect(
      resolveOptimisticAgent(null, [{ id: 'solo', name: 'Solo' }]),
    ).toEqual({ id: 'solo', name: 'Solo' });
  });

  test('자동 선택 + 에이전트 여럿이면 서버 session_created를 기다린다', () => {
    expect(
      resolveOptimisticAgent(null, [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ]),
    ).toBeNull();
  });
});
