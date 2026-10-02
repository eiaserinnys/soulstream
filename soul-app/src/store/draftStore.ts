import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { settingsStorage } from './settingsStorage';

interface DraftState {
  drafts: Record<string, string>;
  write(key: string, value: string): void;
  remove(key: string, submitted?: string): void;
}

export const useDraftStore = create<DraftState>()(persist((set) => ({
  drafts: {},
  write: (key, value) => {
    if (!useDraftStore.persist.hasHydrated()) return;
    set(state => ({ drafts: { ...state.drafts, [key]: value } }));
  },
  remove: (key, submitted) => {
    if (!useDraftStore.persist.hasHydrated()) return;
    set(state => {
      if (submitted !== undefined && state.drafts[key] !== submitted) return state;
      const { [key]: removed, ...drafts } = state.drafts;
      return { drafts };
    });
  },
}), {
  name: 'soul-app-drafts',
  storage: createJSONStorage(() => settingsStorage),
  partialize: state => ({ drafts: state.drafts }),
}));
