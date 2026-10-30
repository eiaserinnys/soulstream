import { useContext } from 'react';
import { Platform } from 'react-native';
import { useSafeAreaInsets, type EdgeInsets } from 'react-native-safe-area-context';
import { DuoSideBandContext, RAIL_MIN_INSET_WIDTH } from './tabContract';

export function hasDuoSideBand(insets: EdgeInsets): boolean {
  return Platform.OS === 'ios' && insets.right >= RAIL_MIN_INSET_WIDTH && insets.left === 0;
}

export function useDuoSideBand(): boolean {
  const fromPhone = useContext(DuoSideBandContext);
  const insets = useSafeAreaInsets();
  return fromPhone ?? hasDuoSideBand(insets);
}
