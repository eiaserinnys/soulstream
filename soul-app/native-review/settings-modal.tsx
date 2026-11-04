import React, { useCallback, useRef } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppModalSurface } from '../src/components/AppModalSurface';
import { DuoRailOverride } from '../src/components/navigation/DuoRailOverride';
import { useDuoSideBand } from '../src/navigation/duoSideBand';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import { PhaseMetrics } from './phase-metrics';

// Same surface and props as SettingsModal, with diagnostics in its native window.
export function SettingsModal({ visible, onClose }: { visible: boolean; onClose(): void }) {
  const request = useRef(onClose);
  const duo = useDuoSideBand();
  const insets = useSafeAreaInsets();
  const registerCloseRequest = useCallback((close: () => void) => { request.current = close; }, []);
  return <AppModalSurface visible={visible} variant="expanded" modalId="modal_settings" animationType="fade" presentationStyle="pageSheet"
    sideBand={duo && visible ? <DuoRailOverride /> : undefined} sideBandWidth={duo ? insets.right : 0}
    onRequestClose={() => request.current()} surfaceTestID="settings-modal" safeAreaTestID="settings-modal-safe-area">
    {visible ? <SettingsScreen flattened onClose={onClose} registerCloseRequest={registerCloseRequest} /> : null}
    <PhaseMetrics />
  </AppModalSurface>;
}
