import type { Session } from '../../api/types';
import { mergeFolderSessionItems } from '../useFolderPagination';

function s(id: string, updatedAt: string, overrides: Partial<Session> = {}): Session {
  return {
    agentSessionId: id,
    displayName: id,
    status: 'idle',
    createdAt: updatedAt,
    updatedAt,
    ...overrides,
  };
}

describe('mergeFolderSessionItems', () => {
  test('같은 세션의 status/profile을 보강하고 updatedAt DESC로 정렬한다', () => {
    const out = mergeFolderSessionItems(
      [
        s('a', '2026-05-05T00:00:00Z', {
          folderId: 'f1',
          status: 'idle',
        }),
        s('b', '2026-05-04T00:00:00Z', { folderId: 'f1' }),
      ],
      [
        s('a', '2026-05-06T00:00:00Z', {
          folderId: 'f1',
          status: 'running',
          agentName: '서소영',
          agentPortraitUrl: '/api/nodes/node-1/agents/seosoyoung/portrait',
        }),
      ],
    );

    expect(out.map((it) => it.agentSessionId)).toEqual(['a', 'b']);
    expect(out[0]).toMatchObject({
      agentSessionId: 'a',
      status: 'running',
      agentName: '서소영',
      agentPortraitUrl: '/api/nodes/node-1/agents/seosoyoung/portrait',
      updatedAt: '2026-05-06T00:00:00Z',
    });
  });

  test('폴더에서 새로 생성된 optimistic 세션을 지역 items에 추가한다', () => {
    const out = mergeFolderSessionItems(
      [],
      [
        s('new-session', '2026-05-07T00:00:00Z', {
          folderId: 'f1',
          status: 'running',
          agentName: '서소영',
        }),
      ],
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      agentSessionId: 'new-session',
      folderId: 'f1',
      status: 'running',
      agentName: '서소영',
    });
  });
});
