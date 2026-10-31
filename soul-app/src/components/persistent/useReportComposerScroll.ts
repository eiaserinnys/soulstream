import { createContext, useCallback, useEffect, useRef } from 'react';
import { Keyboard, Platform, type ScrollView } from 'react-native';

/** The reading surface owns scrolling; its nested composer reports focus. */
export const ReportComposerFocusContext = createContext<((focused: boolean) => void) | undefined>(undefined);

export function useReportComposerScroll(getScrollTarget?: () => number | null) {
  const scroll = useRef<ScrollView>(null);
  const focused = useRef(false);
  const keepComposerVisible = useCallback(() => {
    if (!focused.current) return;
    requestAnimationFrame(() => {
      if (!focused.current) return;
      const target = getScrollTarget?.();
      if (target === null) return;
      if (target === undefined) scroll.current?.scrollToEnd({ animated: false });
      else scroll.current?.scrollTo({ y: target, animated: false });
    });
  }, [getScrollTarget]);
  const onFocusChange = useCallback((next: boolean) => {
    focused.current = next;
    keepComposerVisible();
  }, [keepComposerVisible]);
  useEffect(() => {
    const subscription = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', keepComposerVisible);
    return () => subscription.remove();
  }, [keepComposerVisible]);
  return { scroll, onFocusChange, keepComposerVisible };
}
