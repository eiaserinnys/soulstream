import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, PanResponder, StyleSheet } from 'react-native';
import { useTokens, type DesignTokens } from '../../theme';

interface Props {
  /** 현재 좌측 패널 폭 (pt). PanResponder 시작 시 baseline으로 캡처. */
  initialWidth: number;
  /** 드래그 중 매 이동마다 새 폭을 부모에 통지. 부모가 store clamp/persist 처리. */
  onWidthChange: (next: number) => void;
}

/**
 * 가로 3-pane 레이아웃의 세로 드래그 바.
 *
 * 빌드 18까지는 PanResponder를 useMemo([initialWidth, onWidthChange])로 만들었던 탓에,
 * 드래그 도중 부모가 setState로 폭을 갱신할 때마다 PanResponder가 매번 재생성되어
 * 진행 중인 제스처 트래킹이 끊겼다 (스플리터가 제자리로 튕기는 증상).
 *
 * 빌드 19: PanResponder는 마운트 시 1회만 생성하고, 최신 props는 ref로 읽어
 * closure stale을 회피한다. dx는 grant 시점의 baseline에 누적하여 부모에 통지.
 */
export function Splitter({ initialWidth, onWidthChange }: Props) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const [dragging, setDragging] = useState(false);

  // 항상 최신 props를 PanResponder closure에서 읽기 위한 ref. 매 렌더마다 갱신.
  const propsRef = useRef({ initialWidth, onWidthChange });
  useEffect(() => {
    propsRef.current = { initialWidth, onWidthChange };
  });

  // 드래그 시작 시점의 부모 폭을 baseline으로 잡고, dx를 누적해 새 폭을 통지.
  const startWidthRef = useRef(initialWidth);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_, gesture) =>
          Math.abs(gesture.dx) > 2 || Math.abs(gesture.dy) > 2,
        onPanResponderGrant: () => {
          startWidthRef.current = propsRef.current.initialWidth;
          setDragging(true);
        },
        onPanResponderMove: (_, gesture) => {
          propsRef.current.onWidthChange(startWidthRef.current + gesture.dx);
        },
        onPanResponderRelease: () => setDragging(false),
        onPanResponderTerminate: () => setDragging(false),
      }),
    []
  );

  return (
    <View
      {...responder.panHandlers}
      testID="splitter-touch-zone"
      style={styles.touchZone}
    >
      <View
        testID="splitter-grabber"
        style={[styles.grabber, dragging && styles.grabberActive]}
      />
    </View>
  );
}

function makeStyles(t: DesignTokens) {
  const c = t.colors;
  return StyleSheet.create({
    // 제스처 frame은 44/48pt지만 음수 margin으로 보이는 gutter 폭만 차지한다.
    touchZone: {
      width: t.hitTarget.min,
      marginHorizontal: (t.tabletShell.panelGap - t.hitTarget.min) / 2,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'transparent',
      // split 행이 isolation 경계를 소유하므로 이 zIndex는 이웃 pane까지만 앞선다.
      zIndex: 1,
    },
    grabber: {
      width: t.uiSpacing.xs,
      height: t.uiSpacing.xxxl,
      borderRadius: t.foundation.radius.round,
      backgroundColor: c.border,
      opacity: 0.58,
    },
    grabberActive: {
      backgroundColor: c.accent,
      opacity: 1,
    },
  });
}
