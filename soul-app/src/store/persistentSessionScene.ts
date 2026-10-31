import { createStore } from 'zustand/vanilla';
import type { PersistentSessionResource } from '../api/persistentSessionEndpoints';

export interface PersistentSessionScene {
  session: PersistentSessionResource | null;
  scene: 'conversation' | 'cards' | 'reports';
  reportCount: number;
  hasReports: boolean;
  selectedCardId: string | null;
  visible: boolean;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  leave: () => void;
  open: (session: PersistentSessionResource) => void;
  toggleScene: () => void;
  toggleCards: () => void;
  toggleReports: () => void;
  setReportAvailability: (count: number, available: boolean) => void;
  selectCard: (cardId: string | null) => void;
  swipe: (direction: 'left' | 'right') => void;
}

/** 인증된 UI 인스턴스가 소유한다. 화면 폭이 바뀌어도 같은 store를 유지한다. */
export function createPersistentSessionScene() {
  return createStore<PersistentSessionScene>((set, get) => ({
    session: null,
    scene: 'conversation',
    reportCount: 0,
    hasReports: false,
    selectedCardId: null,
    visible: false,
    settingsOpen: false,
    setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
    leave: () => set({ visible: false }),
    open: (session) => set({ session, scene: 'conversation', selectedCardId: null, reportCount: 0, hasReports: false, visible: true }),
    toggleScene: () => set((state) => ({
      scene: state.scene === 'conversation' ? 'cards' : 'conversation',
      selectedCardId: null,
    })),
    toggleCards: () => set((state) => ({ scene: state.scene === 'cards' ? 'conversation' : 'cards', selectedCardId: null })),
    toggleReports: () => set((state) => ({ scene: state.scene === 'reports' ? 'conversation' : 'reports', selectedCardId: null })),
    setReportAvailability: (reportCount, hasReports) => set((state) =>
      state.reportCount === reportCount && state.hasReports === hasReports ? state : { reportCount, hasReports }),
    selectCard: (selectedCardId) => set({ scene: 'cards', selectedCardId }),
    swipe: (direction) => {
      const state = get();
      if (direction === 'right' && state.scene === 'cards' && state.selectedCardId) {
        state.selectCard(null);
      } else if ((direction === 'right' && (state.scene === 'cards' || state.scene === 'reports'))
        || (direction === 'left' && state.scene === 'conversation')) {
        state.toggleScene();
      }
    },
  }));
}
