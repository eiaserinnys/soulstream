import { useCallback, useLayoutEffect, useRef } from 'react';
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { useOptionalLayoutContinuity } from '../navigation/LayoutContinuityContext';

/** Shared by native ScrollView and FlatList owners; geometry and refs stay local. */
export function useContinuityScroll(key: string, scrollTo: (y: number) => void, ready = true) {
  const continuity = useOptionalLayoutContinuity();
  const metrics = useRef({ key, height: 0, content: 0, pending: continuity?.readScroll(key), offset: continuity?.readScroll(key)?.offsetY ?? 0 });
  if (metrics.current.key !== key) metrics.current = {
    key, height: 0, content: 0, pending: continuity?.readScroll(key), offset: continuity?.readScroll(key)?.offsetY ?? 0,
  };
  const move = useRef(scrollTo);
  move.current = scrollTo;
  const restore = useCallback(() => {
    const state = metrics.current;
    if (!ready || !state.pending || state.height <= 0 || state.content <= 0) return false;
    const offset = Math.max(0, Math.min(state.pending.offsetY, state.content - state.height));
    state.pending = undefined;
    state.offset = offset;
    move.current(offset);
    return true;
  }, [ready]);
  useLayoutEffect(() => { restore(); }, [key, restore]);
  return {
    hasPosition: continuity?.readScroll(key) !== undefined,
    onLayout(event: LayoutChangeEvent) {
      const height = event.nativeEvent.layout.height;
      if (metrics.current.height && metrics.current.height !== height) {
        metrics.current.pending = { offsetY: metrics.current.offset };
      }
      metrics.current.height = height;
      restore();
    },
    onContentSizeChange(_width: number, height: number) {
      metrics.current.content = height;
      return restore();
    },
    onScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
      if (metrics.current.pending) return;
      const offsetY = event.nativeEvent.contentOffset.y;
      metrics.current.offset = offsetY;
      continuity?.writeScroll(key, { offsetY });
    },
    onScrollBeginDrag() { metrics.current.pending = undefined; },
  };
}
