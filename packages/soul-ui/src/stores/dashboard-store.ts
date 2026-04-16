/**
 * Soul Dashboard - Zustand Store
 *
 * 대시보드 전역 상태 관리.
 * 세션 목록, 활성 세션, 선택된 노드, SSE 이벤트 처리를 담당합니다.
 *
 * 핵심 원칙: EventTreeNode 트리가 소스 오브 트루스.
 * SSE 이벤트가 도착하면 트리에 삽입. 레이아웃 엔진은 트리를 DFS 순회하여 렌더링.
 *
 * Mutable tree + version counter 전략:
 * - 트리 노드는 in-place 변경 (text_delta가 가장 빈번, O(1) 필요)
 * - 변경 후 treeVersion++로 리렌더 트리거
 *
 * 구조:
 * - 타입 정의는 ./dashboard-store-types.ts
 * - 5개 slice로 액션 분리 (slices/)
 * - 본 파일은 슬라이스 합성 + reset + persist 설정만 담당
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SessionSummary } from "@shared/types";
import { createProcessingContext } from "./processing-context";
import type { DashboardState, DashboardActions } from "./dashboard-store-types";
import { createUISlice } from "./slices/ui-slice";
import { createCatalogSlice } from "./slices/catalog-slice";
import { createSelectionSlice } from "./slices/selection-slice";
import { createDraftSlice } from "./slices/draft-slice";
import { createSessionSlice } from "./slices/session-slice";

// === Re-exports for backward compatibility ===

export type {
  ProfileConfig,
  DashboardAgentConfig,
  DashboardConfig,
  SelectedEventNodeData,
  FolderSortMode,
  MobileTab,
  ProcessEventsResult,
  DashboardState,
  DashboardActions,
} from "./dashboard-store-types";

// === Unread Utility ===

/** 세션이 읽지 않은 상태인지 판단한다 */
export function isSessionUnread(session: SessionSummary): boolean {
  return (session.lastEventId ?? 0) > (session.lastReadEventId ?? 0);
}

// === Store ===

export const useDashboardStore = create<DashboardState & DashboardActions>()(
  persist(
    (set, get, store) => {
      const slices = {
        ...createUISlice(set, get, store),
        ...createCatalogSlice(set, get, store),
        ...createSelectionSlice(set, get, store),
        ...createDraftSlice(set, get, store),
        ...createSessionSlice(set, get, store),
      };

      // 초기 state 스냅샷 (모든 slice의 초기 필드 값) — reset의 정본.
      // `Object.fromEntries`의 타입은 일반화되어 직접 캐스팅이 어려우므로 `unknown` 경유.
      const initialStateSnapshot = Object.fromEntries(
        Object.entries(slices).filter(([, v]) => typeof v !== "function"),
      ) as unknown as DashboardState;

      return {
        ...slices,
        reset: () => {
          // collapsedNodeIds, processingCtx는 매번 새 인스턴스로 생성하여 Set/객체 공유 방지
          set({
            ...initialStateSnapshot,
            collapsedNodeIds: new Set<string>(),
            processingCtx: createProcessingContext(),
          });
        },
      };
    },
    {
      name: "soul-dashboard-storage",
      // 스토리지 모드 + 입력창 draft 영속화 (세션 데이터는 제외)
      partialize: (state) => ({
        storageMode: state.storageMode,
        drafts: state.drafts,
        folderSortMode: state.folderSortMode,
      }),
    },
  ),
);

// === Tree Utility Functions (re-export for backward compat) ===

export { countTreeNodes, countStreamingNodes, findTreeNode } from "./tree-utils";
