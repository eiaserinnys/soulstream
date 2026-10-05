import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  Keyboard,
  Platform,
  StyleSheet,
  View,
  type AppStateStatus,
  type KeyboardEvent,
  type LayoutChangeEvent,
  type ViewProps,
} from 'react-native';

type KeyboardAvoidanceBehavior = 'height' | 'padding';
type KeyboardFrame = KeyboardEvent['endCoordinates'];

interface WindowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Props extends ViewProps {
  behavior?: KeyboardAvoidanceBehavior;
  onOverlapChange?(overlap: number): void;
}

/**
 * 앱 수명주기와 화면 좌표를 함께 소유하는 키보드 회피 정본.
 *
 * React Native KeyboardAvoidingView는 부모 상대 onLayout 좌표와 키보드의 화면 좌표를
 * 직접 비교하고, AppState 복귀 시 저장한 keyboard frame을 초기화하지 않는다.
 * 이 컴포넌트는 measureInWindow로 좌표계를 통일하고 비활성 전환에서 inset을 폐기한 뒤,
 * 복귀 시 현재 키보드 metrics로 다시 계산한다. 자식은 remount하지 않으므로 채팅 스크롤과
 * 입력 상태도 보존한다.
 */
export function AppKeyboardAvoidingView({
  behavior,
  onOverlapChange,
  children,
  onLayout,
  style,
  ...props
}: Props) {
  const viewRef = useRef<React.ElementRef<typeof View>>(null);
  const windowFrameRef = useRef<WindowFrame | null>(null);
  const restingHeightRef = useRef(0);
  const keyboardFrameRef = useRef<KeyboardFrame | null>(null);
  const activeRef = useRef(AppState.currentState === 'active');
  const requestGenerationRef = useRef(0);
  const insetRef = useRef(0);
  const [inset, setInset] = useState(0);

  const commitInset = useCallback((next: number) => {
    insetRef.current = next;
    onOverlapChange?.(next);
    setInset((current) => (current === next ? current : next));
  }, [onOverlapChange]);

  const measureAndApplyInset = useCallback(
    (keyboardFrame: KeyboardFrame) => {
      const generation = ++requestGenerationRef.current;
      const apply = (frame: WindowFrame) => {
        if (
          generation !== requestGenerationRef.current ||
          !activeRef.current ||
          keyboardFrameRef.current !== keyboardFrame
        ) {
          return;
        }
        let overlapFrame = frame;
        const currentInset = insetRef.current;
        // height 동작은 자기 frame을 줄인다. 줄어든 frame을 그대로 재계산하면
        // overlap이 0이 되어 원복/축소가 반복되므로 기존 inset만큼 복원한다.
        if (
          behavior === 'height' &&
          currentInset > 0 &&
          restingHeightRef.current > 0
        ) {
          const restoredHeight = Math.min(
            frame.height + currentInset,
            Math.max(restingHeightRef.current, frame.height),
          );
          restingHeightRef.current = restoredHeight;
          overlapFrame = { ...frame, height: restoredHeight };
        }
        commitInset(resolveKeyboardOverlap(overlapFrame, keyboardFrame));
      };

      const cachedFrame = windowFrameRef.current;
      if (cachedFrame) apply(cachedFrame);

      const node = viewRef.current;
      if (node?.measureInWindow) {
        node.measureInWindow((x, y, width, height) => {
          const measured = { x, y, width, height };
          if (width > 0 && height > 0) {
            windowFrameRef.current = measured;
            apply(measured);
            return;
          }
        });
      }
    },
    [behavior, commitInset],
  );

  const resetInset = useCallback(() => {
    requestGenerationRef.current += 1;
    keyboardFrameRef.current = null;
    commitInset(0);
  }, [commitInset]);

  useEffect(() => {
    if (!behavior) return;

    const showEvent =
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent =
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSubscription = Keyboard.addListener(showEvent, (event) => {
      if (!activeRef.current || event.isEventFromThisApp === false) return;
      keyboardFrameRef.current = event.endCoordinates;
      Keyboard.scheduleLayoutAnimation(event);
      measureAndApplyInset(event.endCoordinates);
    });
    const hideSubscription = Keyboard.addListener(hideEvent, (event) => {
      if (event.isEventFromThisApp === false) return;
      Keyboard.scheduleLayoutAnimation(event);
      resetInset();
    });
    const appStateSubscription = AppState.addEventListener(
      'change',
      (next: AppStateStatus) => {
        activeRef.current = next === 'active';
        if (!activeRef.current) {
          resetInset();
          return;
        }

        // iOS는 inactive → active 동안 키보드가 계속 떠 있으면 show를 재발행하지 않는다.
        // 저장 프레임을 추측하지 않고 RN이 현재 보유한 화면 좌표를 다시 sanity-check한다.
        const currentFrame = Keyboard.isVisible()
          ? Keyboard.metrics()
          : undefined;
        if (!currentFrame) {
          resetInset();
          return;
        }
        keyboardFrameRef.current = currentFrame;
        measureAndApplyInset(currentFrame);
      },
    );

    return () => {
      requestGenerationRef.current += 1;
      showSubscription.remove();
      hideSubscription.remove();
      appStateSubscription.remove();
    };
  }, [behavior, measureAndApplyInset, resetInset]);

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const layout = event.nativeEvent.layout;
      const node = viewRef.current;
      windowFrameRef.current = null;
      if (node?.measureInWindow) {
        node.measureInWindow((x, y, width, height) => {
          if (width <= 0 || height <= 0) return;
          windowFrameRef.current = { x, y, width, height };
          if (activeRef.current && keyboardFrameRef.current) {
            measureAndApplyInset(keyboardFrameRef.current);
          }
        });
      }
      if (insetRef.current === 0 && layout.height > 0) {
        restingHeightRef.current = layout.height;
      }
      onLayout?.(event);
    },
    [measureAndApplyInset, onLayout],
  );

  const avoidanceStyle =
    behavior === 'padding'
      ? { paddingBottom: inset }
      : behavior === 'height' && inset > 0 && restingHeightRef.current > 0
        ? {
            height: Math.max(restingHeightRef.current - inset, 0),
            flex: 0,
          }
        : undefined;

  return (
    <View
      ref={viewRef}
      style={StyleSheet.compose(style, avoidanceStyle)}
      onLayout={handleLayout}
      {...props}
    >
      {children}
    </View>
  );
}

/**
 * 컨테이너와 키보드가 같은 화면 좌표에서 실제로 겹치는 높이.
 * 떠 있는 키보드처럼 컨테이너 하단을 덮지 않는 프레임은 전체 레이아웃을 밀지 않는다.
 */
export function resolveKeyboardOverlap(
  viewFrame: WindowFrame,
  keyboardFrame: KeyboardFrame,
): number {
  const values = [
    viewFrame.x,
    viewFrame.y,
    viewFrame.width,
    viewFrame.height,
    keyboardFrame.screenX,
    keyboardFrame.screenY,
    keyboardFrame.width,
    keyboardFrame.height,
  ];
  if (
    values.some((value) => !Number.isFinite(value)) ||
    viewFrame.width <= 0 ||
    viewFrame.height <= 0 ||
    keyboardFrame.width <= 0 ||
    keyboardFrame.height <= 0 ||
    keyboardFrame.screenY <= 0
  ) {
    return 0;
  }

  const viewRight = viewFrame.x + viewFrame.width;
  const keyboardRight = keyboardFrame.screenX + keyboardFrame.width;
  const overlapsHorizontally =
    keyboardFrame.screenX < viewRight && keyboardRight > viewFrame.x;
  if (!overlapsHorizontally) return 0;

  const viewBottom = viewFrame.y + viewFrame.height;
  const keyboardBottom = keyboardFrame.screenY + keyboardFrame.height;
  if (keyboardBottom < viewBottom - 1) return 0;

  return Math.min(
    viewFrame.height,
    Math.max(viewBottom - keyboardFrame.screenY, 0),
  );
}
