import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  TextInput,
  type NativeSyntheticEvent,
  type ScrollView,
  type TextInputContentSizeChangeEventData,
  type TextInputProps,
  type TextInputSelectionChangeEventData,
} from 'react-native';

interface GrowingMultilineInputProps extends Omit<
  TextInputProps,
  'multiline' | 'scrollEnabled' | 'value'
> {
  value: string;
  outerScrollRef: React.RefObject<ScrollView | null>;
  minHeight: number;
  maxHeight: number;
  verticalPadding: number;
}

interface GrowingInputLayout {
  height: number;
  scrollEnabled: boolean;
}

export function GrowingMultilineInput({
  value,
  outerScrollRef,
  minHeight,
  maxHeight,
  verticalPadding,
  style,
  onContentSizeChange,
  onFocus,
  onBlur,
  onSelectionChange,
  ...props
}: GrowingMultilineInputProps) {
  const contentHeight = useRef(0);
  const focused = useRef(false);
  const previousValue = useRef(value);
  const allowNextShrink = useRef(false);
  const outerVisibilityFrame = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);
  const initialLayout = resolveGrowingInputLayout({
    contentHeight: 0,
    minHeight,
    maxHeight,
    verticalPadding,
  });
  const layoutRef = useRef<GrowingInputLayout>(initialLayout);
  const [layout, setLayout] = useState<GrowingInputLayout>(initialLayout);

  const ensureOuterVisibility = useCallback(() => {
    outerScrollRef.current?.scrollToEnd({ animated: true });
  }, [outerScrollRef]);
  const cancelScheduledOuterVisibility = useCallback(() => {
    if (outerVisibilityFrame.current === null) return;
    cancelAnimationFrame(outerVisibilityFrame.current);
    outerVisibilityFrame.current = null;
  }, []);
  const scheduleOuterVisibility = useCallback(() => {
    if (!focused.current || outerVisibilityFrame.current !== null) return;
    outerVisibilityFrame.current = requestAnimationFrame(() => {
      outerVisibilityFrame.current = null;
      if (!focused.current) return;
      ensureOuterVisibility();
    });
  }, [ensureOuterVisibility]);

  useEffect(
    () => cancelScheduledOuterVisibility,
    [cancelScheduledOuterVisibility],
  );

  useEffect(() => {
    const next = resolveGrowingInputLayout({
      contentHeight: contentHeight.current,
      minHeight,
      maxHeight,
      verticalPadding,
    });
    layoutRef.current = next;
    setLayout(next);
  }, [maxHeight, minHeight, verticalPadding]);

  useEffect(() => {
    allowNextShrink.current = value.length < previousValue.current.length;
    previousValue.current = value;
    if (value) return;
    contentHeight.current = 0;
    allowNextShrink.current = false;
    const next = {
      height: minHeight,
      scrollEnabled: false,
    };
    layoutRef.current = next;
    setLayout(next);
  }, [minHeight, value]);

  const handleContentSizeChange = (
    event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>,
  ) => {
    const measuredContentHeight = event.nativeEvent.contentSize.height;
    const next = resolveGrowingInputLayout({
      contentHeight: measuredContentHeight,
      minHeight,
      maxHeight,
      verticalPadding,
    });
    const current = layoutRef.current;
    const isShrink = next.height < current.height;
    const acceptsMeasurement = !isShrink || allowNextShrink.current;
    const activeLayout = acceptsMeasurement ? next : current;
    const heightIncreased = acceptsMeasurement && next.height > current.height;

    if (acceptsMeasurement) {
      contentHeight.current = measuredContentHeight;
      if (isShrink) allowNextShrink.current = false;
      if (
        next.height !== current.height
        || next.scrollEnabled !== current.scrollEnabled
      ) {
        layoutRef.current = next;
        setLayout(next);
      }
    }

    if (
      focused.current
      && (heightIncreased || !activeLayout.scrollEnabled)
    ) {
      scheduleOuterVisibility();
    }
    onContentSizeChange?.(event);
  };

  const handleSelectionChange = (
    event: NativeSyntheticEvent<TextInputSelectionChangeEventData>,
  ) => {
    if (focused.current && !layoutRef.current.scrollEnabled) scheduleOuterVisibility();
    onSelectionChange?.(event);
  };

  return (
    <TextInput
      {...props}
      value={value}
      multiline
      allowFontScaling
      scrollEnabled={layout.scrollEnabled}
      style={[style, {
        minHeight,
        maxHeight,
        height: layout.height,
      }]}
      onContentSizeChange={handleContentSizeChange}
      onSelectionChange={handleSelectionChange}
      onFocus={(event) => {
        focused.current = true;
        ensureOuterVisibility();
        onFocus?.(event);
      }}
      onBlur={(event) => {
        focused.current = false;
        cancelScheduledOuterVisibility();
        onBlur?.(event);
      }}
    />
  );
}

function resolveGrowingInputLayout({
  contentHeight,
  minHeight,
  maxHeight,
  verticalPadding,
}: {
  contentHeight: number;
  minHeight: number;
  maxHeight: number;
  verticalPadding: number;
}): GrowingInputLayout {
  const measuredHeight = Math.ceil(contentHeight + verticalPadding * 2);
  return {
    height: Math.min(maxHeight, Math.max(minHeight, measuredHeight)),
    scrollEnabled: measuredHeight >= maxHeight,
  };
}
