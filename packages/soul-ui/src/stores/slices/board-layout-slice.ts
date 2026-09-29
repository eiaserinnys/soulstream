import type { StateCreator } from "zustand";
import type {
  DashboardActions,
  DashboardState,
  FolderBoardLayoutSnapshot,
} from "../dashboard-store-types";

export type BoardLayoutSlice = Pick<DashboardState, "folderBoardLayouts"> &
  Pick<DashboardActions, "setFolderBoardLayout">;

/**
 * 업무 보드 워크스페이스의 마지막 레이아웃을 task page id로 영속한다.
 * 부분 병합(shallow merge)으로 여러 소유자(패널 폭 · 오버레이 · 보드 viewport)가
 * 같은 task 키에 독립 필드를 기록해도 서로 덮어쓰지 않는다.
 */
export const createBoardLayoutSlice: StateCreator<
  DashboardState & DashboardActions,
  [],
  [],
  BoardLayoutSlice
> = (set, get) => ({
  folderBoardLayouts: {},

  setFolderBoardLayout: (taskPageId: string, patch: Partial<FolderBoardLayoutSnapshot>) => {
    if (!taskPageId) return;
    const current = get().folderBoardLayouts[taskPageId];
    const next = { ...current, ...patch };
    // 값이 실제로 바뀔 때만 set 하여 불필요한 persist/리렌더를 피한다.
    const unchanged = current
      && Object.keys(patch).every((key) => {
        const typedKey = key as keyof FolderBoardLayoutSnapshot;
        return current[typedKey] === patch[typedKey];
      });
    if (unchanged) return;
    set((state) => ({
      folderBoardLayouts: { ...state.folderBoardLayouts, [taskPageId]: next },
    }));
  },
});
