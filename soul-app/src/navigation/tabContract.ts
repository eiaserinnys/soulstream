import { createContext, useContext } from 'react';
import { Platform } from 'react-native';
import { useSafeAreaInsets, type EdgeInsets } from 'react-native-safe-area-context';

export const ROOT_TAB_ORDER = [
  'DailyTab',
  'FolderTab',
  'PersistentTab',
  'FeedTab',
  'SettingsTab',
] as const;

export const INITIAL_ROOT_TAB: (typeof ROOT_TAB_ORDER)[number] = 'DailyTab';

export const PhoneRailModeContext = createContext(false);
export const RAIL_MIN_INSET_WIDTH = 48;
export const DuoSideBandContext = createContext<boolean | null>(null);

export function hasDuoSideBand(insets: EdgeInsets): boolean {
  return Platform.OS === 'ios' && insets.right >= RAIL_MIN_INSET_WIDTH && insets.left === 0;
}

export function useDuoSideBand(): boolean {
  const fromPhone = useContext(DuoSideBandContext);
  const insets = useSafeAreaInsets();
  return fromPhone ?? hasDuoSideBand(insets);
}

export function usePhoneRailMode(): boolean {
  return useContext(PhoneRailModeContext);
}
