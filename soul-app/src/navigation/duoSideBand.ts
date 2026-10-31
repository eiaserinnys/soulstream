import { useContext } from 'react';
import { Platform } from 'react-native';
import { useSafeAreaInsets, type EdgeInsets } from 'react-native-safe-area-context';
import { DuoSideBandContext, RAIL_MIN_INSET_WIDTH } from './tabContract';

export const DUO_RAIL_END_INSET = 12;

export function getDuoRailTopOffset(windowWidth: number, windowHeight: number): number {
  return windowWidth > windowHeight ? (windowWidth >= 800 ? 200 : 114) : 228;
}

export function splitDuoRailBackAction<T extends { id: string }>(actions: readonly T[] | null | undefined): { backAction: T | null; mainActions: T[] } {
  if (!actions?.length) return { backAction: null, mainActions: [] };
  if (actions[0].id === 'back' || actions[0].id === 'close') return { backAction: actions[0], mainActions: actions.slice(1) };
  return { backAction: null, mainActions: [...actions] };
}

export function hasDuoSideBand(insets: EdgeInsets): boolean {
  return Platform.OS === 'ios' && insets.right >= RAIL_MIN_INSET_WIDTH && insets.left === 0;
}

export function useDuoSideBand(): boolean {
  const fromPhone = useContext(DuoSideBandContext);
  const insets = useSafeAreaInsets();
  return fromPhone ?? hasDuoSideBand(insets);
}
