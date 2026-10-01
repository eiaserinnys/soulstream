import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { settingsStorage } from './settingsStorage';
import type { CardAssignment } from '../api/cardTypes';
import {
  DEFAULT_USER_PREFERENCES,
  normalizeUserPreferences,
  normalizeWallpaperSettings,
  type Appearance,
  type UserPreferencesSnapshot,
  type WallpaperMode,
  type WallpaperSettings,
} from '../api/preferencesEndpoints';

// 사용자가 설정 탭에서 선택하는 서버 유형 레이블 (UI 표시·도움말 용도)
// 런타임 서버 모드는 앱 초기화 시 /api/config에서 별도 조회
export type ServerType = 'soul-server' | 'orchestrator';

export type {
  Appearance,
  UserPreferencesSnapshot,
  WallpaperMode,
  WallpaperSettings,
};

interface SettingsState {
  cardAssignments: Record<string, CardAssignment>;
  setCardAssignment: (serverUrl: string, assignment: CardAssignment) => void;
  serverUrl: string;
  serverType: ServerType;
  // nodeId: /api/config에서 자동 페치. persist 포함(오프라인 재시작 시 이전 값 표시,
  //   서버 연결 시 useEffect에서 갱신됨).
  nodeId: string;
  appearance: Appearance;
  wallpaper: WallpaperSettings;
  setSettings: (serverUrl: string, serverType: ServerType) => void;
  setNodeId: (nodeId: string) => void;
  setAppearance: (appearance: Appearance) => void;
  setWallpaper: (wallpaper: WallpaperSettings) => void;
  setWallpaperMode: (mode: WallpaperMode) => void;
  applyUserPreferences: (preferences: UserPreferencesSnapshot) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      cardAssignments: {},
      setCardAssignment: (serverUrl, assignment) => set((state) => ({
        cardAssignments: { ...state.cardAssignments, [serverUrl]: assignment },
      })),
      serverUrl: '',
      serverType: 'soul-server',
      nodeId: '',
      appearance: DEFAULT_USER_PREFERENCES.appearance,
      wallpaper: DEFAULT_USER_PREFERENCES.wallpaper,
      setSettings: (serverUrl, serverType) => set({ serverUrl, serverType }),
      setNodeId: (nodeId) => set({ nodeId }),
      setAppearance: (appearance) => set({ appearance }),
      setWallpaper: (wallpaper) =>
        set({ wallpaper: normalizeWallpaperSettings(wallpaper) }),
      setWallpaperMode: (mode) =>
        set((state) => ({
          wallpaper: normalizeWallpaperSettings(
            mode === 'photo' ? { ...state.wallpaper, mode } : { mode },
          ),
        })),
      applyUserPreferences: (preferences) => {
        const normalized = normalizeUserPreferences(preferences);
        set({
          appearance: normalized.appearance,
          wallpaper: normalized.wallpaper,
        });
      },
    }),
    {
      name: 'soul-app-settings',
      storage: createJSONStorage(() => settingsStorage),
    }
  )
);
