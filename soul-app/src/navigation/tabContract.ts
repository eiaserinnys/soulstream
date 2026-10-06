export const ROOT_TAB_ORDER = [
  'DailyTab',
  'FolderTab',
  'PersistentTab',
  'FeedTab',
  'SettingsTab',
] as const;

export const INITIAL_ROOT_TAB: (typeof ROOT_TAB_ORDER)[number] = 'DailyTab';
