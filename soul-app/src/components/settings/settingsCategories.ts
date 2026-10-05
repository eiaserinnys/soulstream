import type Ionicons from '@expo/vector-icons/Ionicons';
import type React from 'react';

export type SettingsCategory =
  | 'display'
  | 'owned-agents'
  | 'connection'
  | 'backends'
  | 'recurring-jobs'
  | 'persistent'
  | 'review-policy'
  | 'diagnostics';

export interface SettingsCategoryDefinition {
  id: SettingsCategory;
  label: string;
  group: string;
  description: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
}

export const SETTINGS_CATEGORIES: readonly SettingsCategoryDefinition[] = [
  { id: 'display', label: '화면과 배경', group: '개인 환경', description: '외양, 배경', icon: 'color-palette-outline' },
  { id: 'owned-agents', label: '내 에이전트', group: '개인 환경', description: '이름과 연결 키 관리', icon: 'people-outline' },
  { id: 'connection', label: '서버 연결', group: '작업과 실행', description: '서버 주소와 연결 확인', icon: 'server-outline' },
  { id: 'backends', label: 'AI 연결과 사용량', group: '작업과 실행', description: 'AI 백엔드와 인증 상태', icon: 'terminal-outline' },
  { id: 'recurring-jobs', label: '반복 작업', group: '작업과 실행', description: '일정과 다음 실행', icon: 'repeat-outline' },
  { id: 'persistent', label: '영구 에이전트 세션', group: '작업과 실행', description: 'Persistent Agent Session', icon: 'infinite-outline' },
  { id: 'review-policy', label: '요청 검수', group: '관리와 문제 해결', description: '새 세션 실행 후 결과 검수', icon: 'checkmark-done-outline' },
  { id: 'diagnostics', label: '진단과 로그', group: '관리와 문제 해결', description: '문제 해결과 진단 정보', icon: 'pulse-outline' },
];
