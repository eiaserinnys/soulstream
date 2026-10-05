import type { Session } from './types';

export const FEED_PAGE_SIZE = 30;

export interface FeedPage {
  sessions: Session[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
}
