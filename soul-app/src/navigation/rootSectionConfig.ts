import Ionicons from '@expo/vector-icons/Ionicons';

export type RootSectionKey =
  | 'FolderTab'
  | 'DailyTab'
  | 'StarredTab'
  | 'ProjectTab'
  | 'FeedTab'
  | 'ChatTab'
  | 'SettingsTab';

export interface RootSectionDefinition {
  title: string;
  icon: keyof typeof Ionicons.glyphMap;
}

export const ROOT_SECTION_CONFIG: Record<RootSectionKey, RootSectionDefinition> = {
  FolderTab: { title: '폴더', icon: 'folder-outline' },
  DailyTab: { title: '카드', icon: 'grid-outline' },
  StarredTab: { title: '중요 작업', icon: 'star-outline' },
  ProjectTab: { title: '프로젝트', icon: 'folder-outline' },
  FeedTab: { title: '피드', icon: 'reader-outline' },
  ChatTab: { title: '챗', icon: 'chatbubble-ellipses-outline' },
  SettingsTab: { title: '설정', icon: 'settings-outline' },
};
