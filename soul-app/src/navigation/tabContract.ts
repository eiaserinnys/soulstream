import { createContext, useContext } from 'react';

export const ROOT_TAB_ORDER = [
  'DailyTab',
  'FolderTab',
  'PersistentTab',
  'FeedTab',
  'SettingsTab',
] as const;

export const DUO_RAIL_TAB_ORDER = [
  'PersistentTab',
  'DailyTab',
  'FolderTab',
  'FeedTab',
] as const;

export const INITIAL_ROOT_TAB: (typeof ROOT_TAB_ORDER)[number] = 'DailyTab';

export const PhoneRailModeContext = createContext(false);
export const RAIL_MIN_INSET_WIDTH = 48;
export const DuoSideBandContext = createContext<boolean | null>(null);

export function usePhoneRailMode(): boolean {
  return useContext(PhoneRailModeContext);
}
