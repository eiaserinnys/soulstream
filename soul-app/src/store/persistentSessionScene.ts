import { createStore } from 'zustand/vanilla';
import type { PersistentSessionResource } from '../api/persistentSessionEndpoints';

export interface PersistentSessionScene {
  session: PersistentSessionResource | null;
  scene: 'conversation' | 'cards';
  selectedCardId: string | null;
  visible: boolean;
  leave: () => void;
  open: (session: PersistentSessionResource) => void;
  toggleScene: () => void;
  selectCard: (cardId: string | null) => void;
  swipe: (direction: 'left' | 'right') => void;
}

/** 인증된 UI 인스턴스가 소유한다. 화면 폭이 바뀌어도 같은 store를 유지한다. */
export function createPersistentSessionScene() {
  return createStore<PersistentSessionScene>((set, get) => ({
    session: null,
    scene: 'conversation',
    selectedCardId: null,
    visible: false,
    leave: () => set({ visible: false }),
    open: (session) => set({ session, scene: 'conversation', selectedCardId: null, visible: true }),
    toggleScene: () => set((state) => ({
      scene: state.scene === 'conversation' ? 'cards' : 'conversation',
      selectedCardId: null,
    })),
    selectCard: (selectedCardId) => set({ scene: 'cards', selectedCardId }),
    swipe: (direction) => {
      const state = get();
      if (direction === 'right' && state.scene === 'cards' && state.selectedCardId) {
        state.selectCard(null);
      } else if ((direction === 'right' && state.scene === 'cards')
        || (direction === 'left' && state.scene === 'conversation')) {
        state.toggleScene();
      }
    },
  }));
}
