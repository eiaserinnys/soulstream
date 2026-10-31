import React, { useCallback, useRef } from 'react';
import { SettingsScreen } from '../../screens/SettingsScreen';
import { AppModalSurface } from '../AppModalSurface';
import { useDuoSideBand } from '../../navigation/duoSideBand';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DuoRailOverride } from '../navigation/DuoRailOverride';
export function SettingsModal({ visible, onClose }: { visible: boolean; onClose(): void }) {
  const request = useRef(onClose);
  const duo = useDuoSideBand();
  const insets = useSafeAreaInsets();
  const registerCloseRequest = useCallback((close: () => void) => { request.current = close; }, []);
  return <AppModalSurface visible={visible} variant="expanded" modalId="modal_settings" animationType="fade" presentationStyle="pageSheet" sideBand={duo && visible ? <DuoRailOverride /> : undefined} sideBandWidth={duo ? insets.right : 0} onRequestClose={() => request.current()} surfaceTestID="settings-modal" safeAreaTestID="settings-modal-safe-area">
    {visible ? <SettingsScreen flattened onClose={onClose} registerCloseRequest={registerCloseRequest}/> : null}
  </AppModalSurface>;
}
