import { createApiClient } from '../fixture-client';
import { FEED_FIXTURE_DISPLAY_TOTAL, FEED_FIXTURE_RANGE_TOTAL } from '../feed-fixtures';

function setFeedReviewState(search: string): void {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { search },
  });
}

beforeEach(() => setFeedReviewState('?section=entryShell&feedWindow=1'));

it('운영 규모 fixture는 스트림 스냅샷과 각 30행 페이지를 제공한다', async () => {
  const api = createApiClient();
  const streamUrl = api.catalogStreamUrl(undefined, undefined, {
    feedOnly: true,
    feedDisplay: true,
    limit: 30,
  });
  const frames = decodeURIComponent(streamUrl.split(',')[1]).trim().split('\n\n');
  const snapshot = JSON.parse(frames[1].replace(/^event: session_list\ndata: /, ''));
  const firstPage = await api.getFeedPage('0');
  const nextPage = await api.getFeedPage('30');

  expect(FEED_FIXTURE_RANGE_TOTAL).toBe(9_387);
  expect(FEED_FIXTURE_DISPLAY_TOTAL).toBe(411);
  expect(frames).toHaveLength(2);
  expect(snapshot.sessions).toHaveLength(30);
  expect(snapshot.total).toBe(411);
  expect(snapshot.hasMore).toBe(true);
  expect(snapshot.nextCursor).toBe('30');
  expect(snapshot.sessions.filter((session: { status: string }) => session.status === 'running')).toHaveLength(7);
  expect(snapshot.sessions.filter((session: { reviewState: string }) => session.reviewState === 'needs_review')).toHaveLength(23);
  expect(firstPage.sessions).toHaveLength(30);
  expect(firstPage.nextCursor).toBe('30');
  expect(nextPage.sessions).toHaveLength(30);
  expect(nextPage.nextCursor).toBe('60');
  expect(await api.getSessionsByIds(['public-shell-session-1'])).toHaveLength(1);
  await expect(api.getCatalog()).rejects.toThrow('session_list');
});

it('다음 쪽 오류는 재시도에서 같은 한 쪽만 반환한다', async () => {
  setFeedReviewState('?section=entryShell&feedWindow=1&feedState=pageError');
  const api = createApiClient();
  await expect(api.getFeedPage('30')).rejects.toThrow('다음 쪽');
  await expect(api.getFeedPage('30')).resolves.toMatchObject({
    sessions: expect.any(Array),
    total: 411,
    hasMore: true,
    nextCursor: '60',
  });
});
