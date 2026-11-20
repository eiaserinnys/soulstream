import type { StateCreator } from "zustand";
import type { DashboardActions, DashboardState } from "../dashboard-store-types";

/** 실패 목록이 같으면 store identity를 유지해 말풍선 재렌더를 만들지 않는다. */
function sameFailures(
  current: Record<string, string>,
  incoming: Record<string, string>,
): boolean {
  const currentKeys = Object.keys(current);
  const incomingKeys = Object.keys(incoming);
  if (currentKeys.length !== incomingKeys.length) return false;
  return currentKeys.every((key) => current[key] === incoming[key]);
}

export function getDeliveryFailureInitialState(): Pick<
  DashboardState,
  "deliveryFailuresBySession" | "deliveryFailureRefreshBySession"
> {
  return { deliveryFailuresBySession: {}, deliveryFailureRefreshBySession: {} };
}

export type DeliveryFailureSlice =
  & Pick<DashboardState, "deliveryFailuresBySession" | "deliveryFailureRefreshBySession">
  & Pick<DashboardActions, "setDeliveryFailures" | "requestDeliveryFailureRefresh">;

export const createDeliveryFailureSlice: StateCreator<
  DashboardState & DashboardActions,
  [],
  [],
  DeliveryFailureSlice
> = (set) => ({
  ...getDeliveryFailureInitialState(),

  setDeliveryFailures: (sessionId, failures) =>
    set((state) => {
      const current = state.deliveryFailuresBySession[sessionId] ?? {};
      if (sameFailures(current, failures)) return state;
      return {
        deliveryFailuresBySession: {
          ...state.deliveryFailuresBySession,
          [sessionId]: failures,
        },
      };
    }),

  requestDeliveryFailureRefresh: (sessionId) =>
    set((state) => ({
      deliveryFailureRefreshBySession: {
        ...state.deliveryFailureRefreshBySession,
        [sessionId]: (state.deliveryFailureRefreshBySession[sessionId] ?? 0) + 1,
      },
    })),
});
