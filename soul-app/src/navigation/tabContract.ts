export const ROOT_TAB_ORDER = [
  'DailyTab',
  'FolderTab',
  'FeedTab',
  'ChatTab',
  'SettingsTab',
] as const;

export const INITIAL_ROOT_TAB: (typeof ROOT_TAB_ORDER)[number] = 'DailyTab';
