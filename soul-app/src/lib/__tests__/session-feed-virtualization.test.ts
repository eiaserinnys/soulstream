import { SESSION_FEED_VIRTUALIZATION } from '../session-feed-virtualization';

test('피드 native glass 카드는 작은 가상화 창과 clipped-subview 완화책을 사용한다', () => {
  expect(SESSION_FEED_VIRTUALIZATION.initialNumToRender).toBeLessThanOrEqual(10);
  expect(SESSION_FEED_VIRTUALIZATION.maxToRenderPerBatch).toBeLessThanOrEqual(10);
  expect(SESSION_FEED_VIRTUALIZATION.windowSize).toBeLessThanOrEqual(3);
  expect(SESSION_FEED_VIRTUALIZATION.removeClippedSubviews).toBe(true);
});
