import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { settingsStorage } from './settingsStorage';

export type DraftValue = string | number | boolean | null | DraftValue[] | { [key: string]: DraftValue };
interface DraftState {
  drafts: Record<string, DraftValue>;
  write(key: string, value: DraftValue): void;
  remove(key: string, submitted?: DraftValue): void;
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
      if (submitted !== undefined && JSON.stringify(state.drafts[key]) !== JSON.stringify(submitted)) return state;
      const { [key]: removed, ...drafts } = state.drafts;
      return { drafts };
    });
  },
}), {
  name: 'soul-app-drafts',
  storage: createJSONStorage(() => settingsStorage),
  partialize: state => ({ drafts: state.drafts }),
}));
