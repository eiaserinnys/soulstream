import { createContext, useCallback, useRef } from 'react';
import type { ScrollView } from 'react-native';

/** The reading surface owns scrolling; its nested composer reports focus. */
export const ReportComposerFocusContext = createContext<((focused: boolean) => void) | undefined>(undefined);

export function useReportComposerScroll() {
  const scroll = useRef<ScrollView>(null);
  const focused = useRef(false);
  const keepComposerVisible = useCallback(() => {
    if (!focused.current) return;
    requestAnimationFrame(() => {
      if (focused.current) scroll.current?.scrollToEnd({ animated: false });
    });
  }, []);
  const onFocusChange = useCallback((next: boolean) => {
    focused.current = next;
    keepComposerVisible();
  }, [keepComposerVisible]);
  return { scroll, onFocusChange, keepComposerVisible };
}
