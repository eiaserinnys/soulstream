import type { Session } from '../api/types';

/**
 * UI에서 "검수 대기"를 판정하는 단일 정본.
 *
 * 서버는 reviewRequired로 사람 소유 세션의 검수 자격을 정하고, 종단 결과가 생기면
 * reviewState를 needs_review로 전환한다. 화면은 현재 상태인 reviewState만 읽어야
 * error/interrupted 결과와 reviewRequired가 생략된 부분 delta도 놓치지 않는다.
 */
export function sessionNeedsReview(
  session: Pick<Session, 'reviewState'>,
): boolean {
  return session.reviewState === 'needs_review';
}
