import React, { createContext, useContext, useEffect, useState } from 'react';
import { Keyboard, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useDuoSideBand, useDuoTopBand } from '../src/navigation/duoSideBand';
import { usePersistentSessionScene } from '../src/navigation/PersistentSessionContext';
import { useUIStore } from '../src/store/uiStore';

export const PhaseContext = createContext('preparing');

export function PhaseMetrics() {
  const phase = useContext(PhaseContext);
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const side = useDuoSideBand();
  const top = useDuoTopBand();
  const scene = usePersistentSessionScene(state => state.scene);
  const visible = usePersistentSessionScene(state => state.visible);
  const settings = useUIStore(state => state.settingsVisible);
  const [keyboard, setKeyboard] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboard(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboard(false));
    return () => { show.remove(); hide.remove(); };
  }, []);
  return <View pointerEvents="none" style={{ position: 'absolute', top: insets.top + 4, left: 4, zIndex: 10000 }}>
    <Text style={{ fontSize: 12, color: '#000', backgroundColor: '#fff' }}>
      {`phase=${phase} window=${width}x${height} insets=t${insets.top},r${insets.right},b${insets.bottom},l${insets.left}\nduoSideBand=${side ? 'yes' : 'no'} duoTopBand=${top ? 'yes' : 'no'} scene=${scene} pasVisible=${visible ? 'yes' : 'no'} settings=${settings ? 'yes' : 'no'} keyboard=${keyboard ? 'yes' : 'no'}`}
    </Text>
  </View>;
}
