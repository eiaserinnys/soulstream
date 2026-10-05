import { filterFeedSessions } from '../feed-filter';
import type { Session, Catalog } from '../../api/types';

const NOW = new Date('2026-05-04T00:00:00Z').getTime();
const HOUR = 60 * 60 * 1000;

function mkSession(
  id: string,
  hoursAgo: number,
  folderId: string | null = null,
): Session {
  return {
    agentSessionId: id,
    displayName: id,
    status: 'idle',
    createdAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
    updatedAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
    folderId,
  };
}

function mkCatalog(
  folders: Array<{ id: string; excludeFromFeed?: boolean }> = [],
  sessions: Record<string, { folderId: string | null }> = {},
): Catalog {
  return {
    folders: folders.map((f) => ({
      id: f.id,
      name: f.id,
      sortOrder: 0,
      settings: { excludeFromFeed: f.excludeFromFeed ?? false },
    })),
    sessions: Object.fromEntries(
      Object.entries(sessions).map(([sid, v]) => [
        sid,
        { folderId: v.folderId, displayName: null },
      ]),
    ),
  };
}

describe('filterFeedSessions', () => {
  test('24h 윈도를 적용하지 않고 오래된 세션도 포함한다', () => {
    const sessions = [mkSession('s1', 1), mkSession('s2', 25)];
    const out = filterFeedSessions(sessions, mkCatalog());
    expect(out.map((s) => s.agentSessionId)).toEqual(['s1', 's2']);
  });

  test('유효한 활동시각이 하나도 없는 세션은 제외', () => {
    const broken = { ...mkSession('s1', 1), createdAt: '', updatedAt: '' };
    const out = filterFeedSessions([broken], mkCatalog());
    expect(out).toEqual([]);
  });

  test('lastMessage가 없으면 createdAt을 쓰고 legacy updatedAt은 마지막 fallback이다', () => {
    const created = { ...mkSession('created', 2), updatedAt: '' };
    const legacy = { ...mkSession('legacy', 1), createdAt: '' };

    expect(filterFeedSessions([legacy, created], mkCatalog()).map((s) => s.agentSessionId))
      .toEqual(['legacy', 'created']);
  });

  test('excludeFromFeed 폴더의 세션 제외 — catalog.sessions 매핑 우선', () => {
    const sessions = [
      mkSession('s1', 1, null),
      mkSession('s2', 1, 'f-archive'),
      mkSession('s3', 1, 'f-active'),
    ];
    const catalog = mkCatalog(
      [
        { id: 'f-archive', excludeFromFeed: true },
        { id: 'f-active', excludeFromFeed: false },
      ],
      {
        s1: { folderId: null },
        s2: { folderId: 'f-archive' },
        s3: { folderId: 'f-active' },
      },
    );
    const out = filterFeedSessions(sessions, catalog);
    expect(out.map((s) => s.agentSessionId).sort()).toEqual(['s1', 's3']);
  });

  test('catalog 준비 전에는 피드 표시 결과를 비워 시작 플래시를 막는다', () => {
    const sessions = [
      mkSession('hidden', 2, 'hidden'),
      mkSession('visible', 1, null),
    ];

    const out = filterFeedSessions(sessions, mkCatalog(), { catalogReady: false });

    expect(out).toEqual([]);
  });

  test('catalog.sessions에 매핑이 없으면 session.folderId를 fallback으로 사용', () => {
    const sessions = [mkSession('s1', 1, 'f-archive')];
    const catalog = mkCatalog([{ id: 'f-archive', excludeFromFeed: true }], {});
    const out = filterFeedSessions(sessions, catalog);
    expect(out).toEqual([]);
  });

  test('미분류 세션(folderId null)은 항상 포함 — excludeFromFeed 영향 없음', () => {
    const sessions = [mkSession('s1', 1, null)];
    const catalog = mkCatalog([{ id: 'f-archive', excludeFromFeed: true }], {
      s1: { folderId: null },
    });
    const out = filterFeedSessions(sessions, catalog);
    expect(out.map((s) => s.agentSessionId)).toEqual(['s1']);
  });

  test('lastMessage가 없으면 createdAt DESC 정렬', () => {
    const sessions = [
      mkSession('old', 5),
      mkSession('new', 1),
      mkSession('mid', 3),
    ];
    const out = filterFeedSessions(sessions, mkCatalog());
    expect(out.map((s) => s.agentSessionId)).toEqual(['new', 'mid', 'old']);
  });

  test('활동시각 동률은 agentSessionId 내림차순으로 결정한다', () => {
    const sessions = [
      mkSession('session-b', 1),
      mkSession('session-a', 1),
    ];

    const out = filterFeedSessions(sessions, mkCatalog());

    expect(out.map((s) => s.agentSessionId)).toEqual([
      'session-b',
      'session-a',
    ]);
  });

  test('유효 lastMessage.timestamp가 createdAt·updatedAt보다 우선한다', () => {
    const sessions = [
      {
        ...mkSession('raw-newer', 1),
        lastMessage: {
          type: 'assistant_message',
          preview: '오래된 유효 메시지',
          timestamp: new Date(NOW - 5 * HOUR).toISOString(),
        },
      },
      {
        ...mkSession('message-newer', 8),
        lastMessage: {
          type: 'user_message',
          preview: '최신 유효 메시지',
          timestamp: new Date(NOW - 2 * HOUR).toISOString(),
        },
      },
    ];

    expect(filterFeedSessions(sessions, mkCatalog()).map((s) => s.agentSessionId))
      .toEqual(['message-newer', 'raw-newer']);
  });

  test('무효 lastMessage는 활동시각으로 쓰지 않는다', () => {
    const invalid = {
      ...mkSession('invalid', 4),
      updatedAt: new Date(NOW).toISOString(),
      lastMessage: {
        type: 'tool_start',
        preview: '도구 실행',
        timestamp: new Date(NOW).toISOString(),
      },
    };
    const valid = mkSession('valid', 2);

    expect(filterFeedSessions([invalid, valid], mkCatalog()).map((s) => s.agentSessionId))
      .toEqual(['valid', 'invalid']);
  });

  test('sessions를 객체(Record)로 받아도 동일 결과', () => {
    const sessions = {
      s1: mkSession('s1', 1),
      s2: mkSession('s2', 25),
    };
    const out = filterFeedSessions(sessions, mkCatalog());
    expect(out.map((s) => s.agentSessionId)).toEqual(['s1', 's2']);
  });

  test('🔴 LLM 세션(sessionType === "llm")은 폴더 설정과 무관하게 항상 제외', () => {
    const sessions: Session[] = [
      { ...mkSession('llm-1', 1), sessionType: 'llm' },
      { ...mkSession('claude-1', 1), sessionType: 'claude' },
      { ...mkSession('legacy', 1) }, // sessionType 미지정 — 통과
    ];
    const out = filterFeedSessions(sessions, mkCatalog());
    expect(out.map((s) => s.agentSessionId).sort()).toEqual(['claude-1', 'legacy']);
  });
});
