import { Platform } from 'react-native';
import { useTextInputContentHeight } from '../chat/useTextInputContentHeight';
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
  onLayout,
  ...props
}: GrowingMultilineInputProps) {
  const measurement = useTextInputContentHeight(value, verticalPadding);
  const contentHeight = useRef(0);
  const focused = useRef(false);
  const previousValue = useRef(value);
  const allowNextShrink = useRef(false);
  const outerVisibilityFrame = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);
  const initialLayout = resolveGrowingInputLayout({
    contentHeight: 0,
    minHeight,
    maxHeight,
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
    if (Platform.OS === 'ios') return;
    const next = resolveGrowingInputLayout({
      contentHeight: contentHeight.current,
      minHeight,
      maxHeight,
    });
    layoutRef.current = next;
    setLayout(next);
  }, [maxHeight, minHeight, verticalPadding]);

  useEffect(() => {
    if (Platform.OS === 'ios') return;
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
    if (Platform.OS === 'ios') {
      onContentSizeChange?.(event);
      return;
    }
    const measuredContentHeight = event.nativeEvent.contentSize.height;
    const next = resolveGrowingInputLayout({
      contentHeight: measuredContentHeight,
      minHeight,
      maxHeight,
    });
    const current = layoutRef.current;
    const isShrink = next.height < current.height;
    const acceptsMeasurement = Platform.OS === 'web' || !isShrink || allowNextShrink.current;
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

  useEffect(() => {
    if (Platform.OS === 'web') handleContentSizeChange({
      nativeEvent: { contentSize: { width: 0, height: measurement.contentHeight } },
    } as NativeSyntheticEvent<TextInputContentSizeChangeEventData>);
  }, [measurement.contentHeight]);

  const handleSelectionChange = (
    event: NativeSyntheticEvent<TextInputSelectionChangeEventData>,
  ) => {
    if (focused.current && !layoutRef.current.scrollEnabled) scheduleOuterVisibility();
    onSelectionChange?.(event);
  };

  return (
    <TextInput
      {...props}
      ref={measurement.ref}
      value={value}
      multiline
      allowFontScaling
      scrollEnabled={layout.scrollEnabled}
      style={[style, {
        minHeight,
        maxHeight,
        // iOS owns intrinsic height; a JS height would prevent Fabric's layout/contentSize event.
        ...(Platform.OS === 'ios' ? {} : { height: layout.height }),
        paddingHorizontal: 0,
        paddingVertical: verticalPadding,
        ...(Platform.OS === 'web' ? { whiteSpace: 'pre-wrap' } : {}),
      }]}
      onContentSizeChange={Platform.OS === 'web' ? undefined : handleContentSizeChange}
      onLayout={Platform.OS === 'ios' ? (event) => {
        const height = event.nativeEvent.layout.height;
        const next = { height, scrollEnabled: height >= maxHeight };
        const current = layoutRef.current;
        if (next.height !== current.height || next.scrollEnabled !== current.scrollEnabled) {
          layoutRef.current = next;
          setLayout(next);
          if (height > current.height || !next.scrollEnabled) scheduleOuterVisibility();
        }
        onLayout?.(event);
      } : onLayout}
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
}: {
  contentHeight: number;
  minHeight: number;
  maxHeight: number;
}): GrowingInputLayout {
  const measuredHeight = Math.ceil(contentHeight);
  return {
    height: Math.min(maxHeight, Math.max(minHeight, measuredHeight)),
    scrollEnabled: measuredHeight > maxHeight,
  };
}
