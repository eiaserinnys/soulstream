import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { settingsStorage } from './settingsStorage';
import type { CardAssignment, CardStatus } from '../api/cardTypes';
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

export interface PersistentSessionDevicePreference {
  openOnStart: boolean;
  lastSessionId: string | null;
  collapsedTaskGroups: CardStatus[];
}

export type PersistentSessionDevicePrefs = Record<string, PersistentSessionDevicePreference>;

export type {
  Appearance,
  UserPreferencesSnapshot,
  WallpaperMode,
  WallpaperSettings,
};

interface SettingsState {
  cardIncludeCompleted: Record<string, boolean>;
  setCardIncludeCompleted: (scope: string, includeCompleted: boolean) => void;
  cardAssignments: Record<string, CardAssignment>;
  setCardAssignment: (serverUrl: string, assignment: CardAssignment) => void;
  serverUrl: string;
  serverType: ServerType;
  // nodeId: /api/config에서 자동 페치. persist 포함(오프라인 재시작 시 이전 값 표시,
  //   서버 연결 시 useEffect에서 갱신됨).
  nodeId: string;
  appearance: Appearance;
  wallpaper: WallpaperSettings;
  persistentSessionDevicePrefs: PersistentSessionDevicePrefs;
  setSettings: (serverUrl: string, serverType: ServerType) => void;
  setNodeId: (nodeId: string) => void;
  setAppearance: (appearance: Appearance) => void;
  setWallpaper: (wallpaper: WallpaperSettings) => void;
  setWallpaperMode: (mode: WallpaperMode) => void;
  getPersistentSessionDevicePreference: (serverUrl: string, email: string | null | undefined) => PersistentSessionDevicePreference;
  setPersistentSessionOpenOnStart: (serverUrl: string, email: string | null | undefined, openOnStart: boolean) => void;
  setPersistentSessionLastSessionId: (serverUrl: string, email: string | null | undefined, sessionId: string | null) => void;
  setPersistentSessionCollapsedTaskGroups: (serverUrl: string, email: string | null | undefined, collapsedTaskGroups: CardStatus[]) => void;
  applyUserPreferences: (preferences: UserPreferencesSnapshot) => void;
}

const DEFAULT_PERSISTENT_SESSION_DEVICE_PREFERENCE: PersistentSessionDevicePreference = {
  openOnStart: false,
  lastSessionId: null,
  collapsedTaskGroups: ['todo'],
};

function persistentSessionDevicePreferenceKey(serverUrl: string, email: string | null | undefined): string | null {
  const normalizedEmail = email?.trim().toLowerCase();
  if (!serverUrl || !normalizedEmail) return null;
  return JSON.stringify([serverUrl, normalizedEmail]);
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      cardIncludeCompleted: {},
      setCardIncludeCompleted: (scope, includeCompleted) => set((state) => ({
        cardIncludeCompleted: { ...state.cardIncludeCompleted, [scope]: includeCompleted },
      })),
      cardAssignments: {},
      setCardAssignment: (serverUrl, assignment) => set((state) => ({
        cardAssignments: { ...state.cardAssignments, [serverUrl]: assignment },
      })),
      serverUrl: '',
      serverType: 'soul-server',
      nodeId: '',
      appearance: DEFAULT_USER_PREFERENCES.appearance,
      wallpaper: DEFAULT_USER_PREFERENCES.wallpaper,
      persistentSessionDevicePrefs: {},
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
      getPersistentSessionDevicePreference: (serverUrl, email) => {
        const key = persistentSessionDevicePreferenceKey(serverUrl, email);
        const stored = key ? get().persistentSessionDevicePrefs[key] : undefined;
        return {
          ...DEFAULT_PERSISTENT_SESSION_DEVICE_PREFERENCE,
          ...stored,
          collapsedTaskGroups: stored?.collapsedTaskGroups ?? DEFAULT_PERSISTENT_SESSION_DEVICE_PREFERENCE.collapsedTaskGroups,
        };
      },
      setPersistentSessionOpenOnStart: (serverUrl, email, openOnStart) => {
        const key = persistentSessionDevicePreferenceKey(serverUrl, email);
        if (!key) return;
        set((state) => ({
          persistentSessionDevicePrefs: {
            ...state.persistentSessionDevicePrefs,
            [key]: {
              ...(state.persistentSessionDevicePrefs[key] ?? DEFAULT_PERSISTENT_SESSION_DEVICE_PREFERENCE),
              openOnStart,
            },
          },
        }));
      },
      setPersistentSessionLastSessionId: (serverUrl, email, sessionId) => {
        const key = persistentSessionDevicePreferenceKey(serverUrl, email);
        if (!key) return;
        set((state) => ({
          persistentSessionDevicePrefs: {
            ...state.persistentSessionDevicePrefs,
            [key]: {
              ...(state.persistentSessionDevicePrefs[key] ?? DEFAULT_PERSISTENT_SESSION_DEVICE_PREFERENCE),
              lastSessionId: sessionId,
            },
          },
        }));
      },
      setPersistentSessionCollapsedTaskGroups: (serverUrl, email, collapsedTaskGroups) => {
        const key = persistentSessionDevicePreferenceKey(serverUrl, email);
        if (!key) return;
        set((state) => ({
          persistentSessionDevicePrefs: {
            ...state.persistentSessionDevicePrefs,
            [key]: {
              ...(state.persistentSessionDevicePrefs[key] ?? DEFAULT_PERSISTENT_SESSION_DEVICE_PREFERENCE),
              collapsedTaskGroups: [...collapsedTaskGroups],
            },
          },
        }));
      },
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
      partialize: (state) => ({
        cardIncludeCompleted: state.cardIncludeCompleted,
        cardAssignments: state.cardAssignments,
        serverUrl: state.serverUrl,
        serverType: state.serverType,
        nodeId: state.nodeId,
        appearance: state.appearance,
        wallpaper: state.wallpaper,
        persistentSessionDevicePrefs: state.persistentSessionDevicePrefs,
      }),
    }
  )
);
