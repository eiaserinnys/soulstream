import React, { useEffect, useRef } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  View,
  type ModalProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { DESIGN_HIT_TARGET, DESIGN_SPACING, useTokens } from '../theme';
import {
  createSurfaceRoles,
  MODAL_BACKDROP_COLOR,
  type SurfaceRoleName,
} from '../theme/surfaceRoles';
import { AppGlassCard } from './AppGlassCard';
import { TabletSafeAreaFrame } from './split/TabletSafeAreaFrame';
import { recordModalVisibility } from '../lib/session-diagnostics-api';
import type { ModalDiagnosticSource } from '../lib/session-diagnostics-core';
import { GlassSurfaceBoundary } from './GlassSurface';

const SUPPORTED_MODAL_ORIENTATIONS: NonNullable<ModalProps['supportedOrientations']> = [
  'portrait',
  'portrait-upside-down',
  'landscape-left',
  'landscape-right',
];

type NativeSheetPresentationStyle = Extract<
  NonNullable<ModalProps['presentationStyle']>,
  'pageSheet' | 'formSheet'
>;

type AppModalSurfaceCommonProps = {
  visible: boolean;
  modalId: ModalDiagnosticSource;
  onRequestClose(): void;
  onDismiss?: ModalProps['onDismiss'];
  children: React.ReactNode;
  animationType?: ModalProps['animationType'];
  surfaceTestID?: string;
  safeAreaTestID?: string;
  sideBand?: React.ReactNode;
  sideBandWidth?: number;
};

type AppModalSurfaceProps = AppModalSurfaceCommonProps & (
  | {
      variant: 'compact';
      presentationStyle?: never;
    }
  | {
      variant: 'expanded';
      presentationStyle: NativeSheetPresentationStyle;
    }
  | {
      variant: 'popover';
      presentationStyle?: never;
    }
  | {
      variant: 'board';
      presentationStyle?: never;
    }
);

interface AppModalPresentation {
  transparent: boolean;
  presentationStyle: 'overFullScreen' | NativeSheetPresentationStyle;
  surfaceRole: Extract<SurfaceRoleName, 'modal' | 'nativeSheet'>;
}

/**
 * custom overlay는 앱이 dim+glass 층을 만들고, native sheet는 UIKit의 층 위에
 * 불투명 앱 표면만 채운다. 두 표현 모델을 variant 타입과 role 선택으로 묶는다.
 */
export function AppModalSurface({
  visible,
  modalId,
  variant,
  onRequestClose,
  onDismiss,
  children,
  animationType = 'slide',
  presentationStyle,
  surfaceTestID,
  safeAreaTestID,
  sideBand,
  sideBandWidth = 0,
}: AppModalSurfaceProps) {
  const t = useTokens();
  const previousVisible = useRef(false);
  const compact = variant === 'compact';
  const popover = variant === 'popover';
  const board = variant === 'board';
  const Layer = board ? GlassSurfaceBoundary : React.Fragment;
  const presentation = resolveAppModalPresentation(variant, presentationStyle);
  const surfaceRole = createSurfaceRoles(t)[presentation.surfaceRole];
  const diagnosticVariant = board ? 'expanded' : variant;
  useEffect(() => {
    if (previousVisible.current !== visible) {
      recordModalVisibility(modalId, diagnosticVariant, visible);
      previousVisible.current = visible;
    }
  }, [modalId, diagnosticVariant, visible]);
  return (
    <Modal
      visible={visible}
      animationType={animationType}
      transparent={presentation.transparent}
      presentationStyle={presentation.presentationStyle}
      backdropColor={!presentation.transparent ? surfaceRole.tokenStyle.backgroundColor : undefined}
      supportedOrientations={SUPPORTED_MODAL_ORIENTATIONS}
      onRequestClose={onRequestClose}
      onDismiss={onDismiss}
    >
      <Layer><View
        testID="app-modal-viewport"
        style={[
          styles.viewport,
          compact
            ? styles.compactViewport
            : popover
              ? styles.popoverViewport
              : board
                ? styles.boardViewport
                : styles.expandedViewport,
          !presentation.transparent ? surfaceRole.tokenStyle : null,
        ]}
      >
        {compact || popover ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="다이얼로그 닫기"
            testID="app-modal-backdrop"
            style={styles.backdrop}
            onPress={onRequestClose}
          />
        ) : null}
        <SideBandFrame width={sideBandWidth}>
        {board ? (
          <TabletSafeAreaFrame>
            <AppGlassCard role={presentation.surfaceRole} testID={surfaceTestID} style={styles.expandedSurface}>
              <View testID={safeAreaTestID} style={styles.boardContent}>{children}</View>
            </AppGlassCard>
          </TabletSafeAreaFrame>
        ) : (
          <AppGlassCard
            role={presentation.surfaceRole}
            testID={surfaceTestID}
            style={
              compact
                ? styles.compactSurface
                : popover
                  ? styles.popoverSurface
                  : styles.expandedSurface
            }
          >
            <SafeAreaView
              testID={safeAreaTestID}
              edges={
                compact
                  ? ['bottom', 'left', 'right']
                  : popover
                    ? []
                    : sideBandWidth
                      ? ['top', 'bottom', 'left']
                    : undefined
              }
              style={
                compact
                  ? styles.compactSafeArea
                  : popover
                    ? styles.popoverSafeArea
                    : styles.expandedSafeArea
              }
            >
              {children}
            </SafeAreaView>
          </AppGlassCard>
        )}
        </SideBandFrame>
        {sideBand}
      </View></Layer>
    </Modal>
  );
}

function SideBandFrame({ width, children }: { width: number; children: React.ReactNode }) {
  return width ? <View style={{ flex: 1, paddingRight: width }}>{children}</View> : <>{children}</>;
}

export function resolveAppModalPresentation(
  variant: 'compact' | 'expanded' | 'popover' | 'board',
  presentationStyle?: NativeSheetPresentationStyle,
): AppModalPresentation {
  if (variant === 'compact' || variant === 'popover' || variant === 'board') {
    return {
      transparent: true,
      presentationStyle: 'overFullScreen',
      surfaceRole: 'modal',
    };
  }
  if (!presentationStyle) {
    throw new Error('Expanded AppModalSurface requires pageSheet or formSheet');
  }
  return {
    transparent: false,
    presentationStyle,
    surfaceRole: 'nativeSheet',
  };
}

const styles = StyleSheet.create({
  viewport: { flex: 1 },
  compactViewport: {
    justifyContent: 'flex-end',
    backgroundColor: MODAL_BACKDROP_COLOR,
  },
  popoverViewport: {
    alignItems: 'flex-end',
    justifyContent: 'flex-start',
    paddingTop: DESIGN_SPACING.xxxl + DESIGN_SPACING.xxl,
    paddingRight: DESIGN_SPACING.lg,
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    minWidth: DESIGN_HIT_TARGET.min,
    minHeight: DESIGN_HIT_TARGET.min,
  },
  expandedViewport: {},
  boardViewport: { backgroundColor: MODAL_BACKDROP_COLOR },
  compactSurface: {
    width: '100%',
    maxHeight: '60%',
    flexShrink: 1,
    overflow: 'hidden',
  },
  popoverSurface: {
    width: 360,
    maxWidth: '92%',
    maxHeight: '78%',
    flexShrink: 1,
    overflow: 'hidden',
  },
  expandedSurface: { flex: 1 },
  compactSafeArea: { flexShrink: 1 },
  popoverSafeArea: { flexShrink: 1 },
  expandedSafeArea: { flex: 1 },
  boardContent: { flex: 1 },
});
