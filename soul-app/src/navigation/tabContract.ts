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
  'SettingsTab',
] as const;

export const INITIAL_ROOT_TAB: (typeof ROOT_TAB_ORDER)[number] = 'DailyTab';

export const PhoneRailModeContext = createContext(false);
export const RAIL_MIN_INSET_WIDTH = 48;
/** 듀오 레일이 장면 위에 떠서 차지하는 폭(pt). 듀오가 아니면 0이다. */
export const DuoRailOverlayContext = createContext(0);
export const DuoSideBandContext = createContext<boolean | null>(null);
export const DuoTopBandContext = createContext<boolean | null>(null);
export const DuoTopBandMainContext = createContext(false);

export function usePhoneRailMode(): boolean {
  return useContext(PhoneRailModeContext);
}
