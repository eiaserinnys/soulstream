import { create } from 'zustand';

export type AppNoticeTone = 'success' | 'error';

export interface AppNoticeInput {
  title: string;
  message: string;
  tone: AppNoticeTone;
}

export interface AppNotice extends AppNoticeInput {
  id: number;
}

interface AppNoticeState {
  notice: AppNotice | null;
  showNotice: (input: AppNoticeInput) => void;
  dismissNotice: (id?: number) => void;
}

let nextNoticeId = 1;

/**
 * 화면 전환과 무관하게 앱 루트 배너가 소비하는 짧은 사용자 피드백 정본.
 * 시스템 Alert가 필요한 확인/선택 흐름과, 비차단 결과 알림을 분리한다.
 */
export const useAppNoticeStore = create<AppNoticeState>((set) => ({
  notice: null,
  showNotice: (input) => {
    set({
      notice: {
        ...input,
        id: nextNoticeId,
      },
    });
    nextNoticeId += 1;
  },
  dismissNotice: (id) => {
    set((state) => {
      if (id !== undefined && state.notice?.id !== id) return state;
      return { notice: null };
    });
  },
}));
