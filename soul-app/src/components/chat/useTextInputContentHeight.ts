import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Platform, TextInput, type NativeSyntheticEvent, type TextInputContentSizeChangeEventData } from 'react-native';

// Both native contentSize and textarea scrollHeight include the input padding.
export function useTextInputContentHeight(value: string, measurementKey: number) {
  const ref = useRef<TextInput>(null);
  const [contentHeight, setContentHeight] = useState(0);
  const onContentSizeChange = useCallback((event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => {
    setContentHeight(event.nativeEvent.contentSize.height);
  }, []);

  useLayoutEffect(() => {
    if (Platform.OS !== 'web') {
      if (!value) setContentHeight(0);
      return;
    }
    const textarea = ref.current as unknown as HTMLTextAreaElement | null;
    if (!textarea) return;
    const measure = () => {
      const { height, minHeight } = textarea.style;
      textarea.style.height = 'auto';
      textarea.style.minHeight = '0px';
      const measuredHeight = textarea.scrollHeight;
      textarea.style.height = height;
      textarea.style.minHeight = minHeight;
      setContentHeight(value ? measuredHeight : 0);
    };
    measure();
    let width = textarea.clientWidth;
    const observer = new ResizeObserver(() => {
      if (width === textarea.clientWidth) return;
      width = textarea.clientWidth;
      measure();
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [value, measurementKey, contentHeight]);

  return { ref, contentHeight, onContentSizeChange: Platform.OS === 'web' ? undefined : onContentSizeChange };
}
