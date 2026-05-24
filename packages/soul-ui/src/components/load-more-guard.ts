export type LoadMoreCallback = () => Promise<unknown> | void;

export interface LoadMoreGate {
  current: boolean;
}

export function runGuardedLoadMore(
  gate: LoadMoreGate,
  loadMore?: LoadMoreCallback,
): boolean {
  if (!loadMore || gate.current) return false;
  gate.current = true;
  try {
    void Promise.resolve(loadMore()).then(
      () => {
        gate.current = false;
      },
      () => {
        gate.current = false;
      },
    );
    return true;
  } catch (error) {
    gate.current = false;
    throw error;
  }
}

export interface VirtualLoadMoreState {
  hasMore?: boolean;
  isLoadingMore: boolean;
  itemCount: number;
  lastVirtualIndex?: number;
  threshold?: number;
}

export function shouldLoadMoreFromVirtualItems({
  hasMore,
  isLoadingMore,
  itemCount,
  lastVirtualIndex,
  threshold = 3,
}: VirtualLoadMoreState): boolean {
  if (!hasMore || isLoadingMore) return false;
  if (itemCount <= 0 || lastVirtualIndex === undefined) return false;
  return lastVirtualIndex >= Math.max(0, itemCount - threshold);
}
