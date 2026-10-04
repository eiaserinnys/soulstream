import React, { useCallback, useRef } from 'react';
import { SettingsScreen } from '../../screens/SettingsScreen';
import { AppModalSurface } from '../AppModalSurface';
export function SettingsModal({ visible, onClose }: { visible: boolean; onClose(): void }) {
  const request = useRef(onClose);
  const registerCloseRequest = useCallback((close: () => void) => { request.current = close; }, []);
  return <AppModalSurface visible={visible} variant="expanded" modalId="modal_settings" animationType="fade" presentationStyle="pageSheet" onRequestClose={() => request.current()} surfaceTestID="settings-modal" safeAreaTestID="settings-modal-safe-area">
    {visible ? <SettingsScreen flattened onClose={onClose} registerCloseRequest={registerCloseRequest}/> : null}
  </AppModalSurface>;
}
