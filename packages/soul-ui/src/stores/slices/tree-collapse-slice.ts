/**
 * Tree Collapse Slice
 *
 * 채팅 트리의 노드 접기/펼치기 상태(collapsedNodeIds) 소유.
 *
 * 3개 액션은 모두 collapsedNodeIds를 갱신하면서 treeVersion도 함께 +1 한다.
 * treeVersion은 event-processing-slice 소유이지만 합성 후에는 full store에서
 * 자유롭게 set 가능하다 (Zustand 합성 패턴 표준).
 */

import type { StateCreator } from "zustand";
import type { DashboardState, DashboardActions } from "../dashboard-store-types";

export type TreeCollapseSlice = Pick<
  DashboardState,
  | "collapsedNodeIds"
> &
  Pick<
    DashboardActions,
    | "toggleNodeCollapse"
    | "setNodeCollapsed"
    | "clearCollapsedNodes"
  >;

/**
 * tree-collapse-slice가 소유하는 collapsedNodeIds 초기값을 매번 새 인스턴스로 생성한다.
 * 슬라이스 초기 state와 세션 리셋(_session-reset) 양쪽이 같은 정본을 공유하도록 한다
 * (design-principles §3 정본 하나). Set은 매번 새로 만들어 인스턴스 공유 방지.
 */
export function getTreeCollapseInitialState(): Pick<DashboardState, "collapsedNodeIds"> {
  return { collapsedNodeIds: new Set<string>() };
}

export const createTreeCollapseSlice: StateCreator<
  DashboardState & DashboardActions,
  [],
  [],
  TreeCollapseSlice
> = (set, get) => ({
  ...getTreeCollapseInitialState(),

  toggleNodeCollapse: (nodeId) => {
    const currentCollapsed = get().collapsedNodeIds;
    const newCollapsed = new Set(currentCollapsed);
    if (newCollapsed.has(nodeId)) {
      newCollapsed.delete(nodeId);
    } else {
      newCollapsed.add(nodeId);
    }
    set({
      collapsedNodeIds: newCollapsed,
      treeVersion: get().treeVersion + 1,
      treeChangeInfo: { type: "collapse-toggle" },
    });
  },

  setNodeCollapsed: (nodeId, collapsed) => {
    const currentCollapsed = get().collapsedNodeIds;
    const newCollapsed = new Set(currentCollapsed);
    if (collapsed) {
      newCollapsed.add(nodeId);
    } else {
      newCollapsed.delete(nodeId);
    }
    set({
      collapsedNodeIds: newCollapsed,
      treeVersion: get().treeVersion + 1,
      treeChangeInfo: { type: "collapse-toggle" },
    });
  },

  clearCollapsedNodes: () => {
    set({
      collapsedNodeIds: new Set<string>(),
      treeVersion: get().treeVersion + 1,
      treeChangeInfo: { type: "collapse-toggle" },
    });
  },
});
