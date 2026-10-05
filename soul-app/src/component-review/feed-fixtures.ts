import type { Folder, Session } from '../api/types';
import type { FeedPage } from '../api/feedPage';
import { FEED_PAGE_SIZE } from '../api/feedPage';
import { entryShellFolders, entryShellSessions } from './fixtures';

export const FEED_FIXTURE_RANGE_TOTAL = 9_387;
export const FEED_FIXTURE_DISPLAY_TOTAL = 411;

export type FeedFixtureState = 'normal' | 'pageLoading' | 'pageError';
export interface FeedFixtureRequest {
  type: 'getFeedPage' | 'getSessionsByIds' | 'getCatalog';
  cursor?: string;
  sessionIds?: string[];
}

const baseTime = Date.parse('2026-10-01T00:00:00.000Z');

function fixtureSession(index: number): Session {
  if (index < 4) return { ...entryShellSessions[index], status: 'running' };
  const isRunning = index < 7;
  const updatedAt = new Date(baseTime - index * 60_000).toISOString();
  return {
    agentSessionId: `public-feed-session-${String(index + 1).padStart(3, '0')}`,
    displayName: isRunning
      ? `실행 중 공개 세션 ${index - 3}`
      : `검수 대기 공개 세션 ${index - 6}`,
    status: isRunning ? 'running' : 'completed',
    reviewRequired: !isRunning,
    reviewState: isRunning ? 'not_required' : 'needs_review',
    createdAt: updatedAt,
    updatedAt,
    folderId: index % 5 === 0 ? null : entryShellFolders[index % entryShellFolders.length].id,
    nodeId: 'public-node',
    agentId: 'public-agent',
    agentName: '예시 에이전트',
    backend: 'codex',
    modelLabel: '예시 모델',
  };
}

export function feedFixturePage(cursor = '0'): FeedPage {
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('피드 fixture cursor가 올바르지 않습니다.');
  const sessions = Array.from(
    { length: Math.min(FEED_PAGE_SIZE, FEED_FIXTURE_DISPLAY_TOTAL - offset) },
    (_, index) => fixtureSession(offset + index),
  );
  const nextOffset = offset + sessions.length;
  return {
    sessions,
    total: FEED_FIXTURE_DISPLAY_TOTAL,
    hasMore: nextOffset < FEED_FIXTURE_DISPLAY_TOTAL,
    nextCursor: nextOffset < FEED_FIXTURE_DISPLAY_TOTAL ? String(nextOffset) : null,
  };
}

export function feedFixtureSnapshot(feedWindow: boolean): FeedPage & { folders: Folder[] } {
  const page = feedWindow
    ? feedFixturePage()
    : {
        sessions: entryShellSessions,
        total: entryShellSessions.length,
        hasMore: false,
        nextCursor: null,
      };
  return { ...page, folders: entryShellFolders };
}

export function feedFixtureSessionLookup(sessionIds: readonly string[]): Session[] {
  const requested = new Set(sessionIds);
  const rows = [
    ...entryShellSessions,
    ...Array.from({ length: FEED_FIXTURE_DISPLAY_TOTAL }, (_, index) => fixtureSession(index)),
  ];
  const byId = new Map(rows.map((session) => [session.agentSessionId, session]));
  return [...requested].flatMap((sessionId) => {
    const row = byId.get(sessionId);
    return row ? [row] : [];
  });
}

export function reviewFeedStreamUrl(
  _lastEventId?: string,
  _instanceId?: string,
  _scope?: { feedOnly?: boolean; feedDisplay?: boolean; limit?: number },
): string {
  const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
  const feedWindow = params.get('feedWindow') === '1';
  const snapshot = feedFixtureSnapshot(feedWindow);
  const frames = [
    `event: stream_meta\ndata: ${JSON.stringify({ latest_id: '3000', instance_id: 'public-feed-instance' })}\n\n`,
    `event: session_list\ndata: ${JSON.stringify({
      folders: snapshot.folders,
      sessions: snapshot.sessions,
      total: snapshot.total,
      hasMore: snapshot.hasMore,
      nextCursor: snapshot.nextCursor,
    })}\n\n`,
  ];
  return `data:text/event-stream;charset=utf-8,${encodeURIComponent(frames.join(''))}`;
}

export function currentFeedFixtureState(): FeedFixtureState {
  const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
  const state = params.get('feedState');
  return state === 'pageLoading' || state === 'pageError' ? state : 'normal';
}
