/**
 * 피드에서 동시에 유지할 native GlassView 수의 정본.
 * 실기기 성능 문제가 확인되면 card 역할 스위치와 함께 이 값만 조정한다.
 */
export const SESSION_FEED_VIRTUALIZATION = {
  initialNumToRender: 8,
  maxToRenderPerBatch: 6,
  windowSize: 2,
  removeClippedSubviews: true,
} as const;
