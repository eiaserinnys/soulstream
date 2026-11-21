import type { SessionDetail } from "@shared/types";
import type { DashboardState } from "../dashboard-store-types";
import { getEventProcessingInitialState } from "./event-processing-slice";

export function getSessionSliceInitialState(): Pick<
  DashboardState,
  | "activeSessionKey"
  | "activeSession"
  | "activeSessionSummary"
  | "persistentSessionDisplaySettings"
> {
  return {
    activeSessionKey: null as string | null,
    activeSession: null as SessionDetail | null,
    activeSessionSummary: null,
    persistentSessionDisplaySettings: null,
  };
}

export function getSessionResetState() {
  const { activeSessionSummary: _omit, ...sessionPartial } = getSessionSliceInitialState();
  const { pendingNotifications: _keepBrowserNotices, ...eventPartial } =
    getEventProcessingInitialState();
  return {
    ...sessionPartial,
    ...eventPartial,
    focusEventId: null,
    focusEventSessionId: null,
    focusEventTarget: null,
    activeRightTab: "chat" as const, // ui-slice 소유 — 세션 전환 시 항상 "chat" 리셋이 의도된 동작
    activeBoardDocumentId: null,
    activeCustomViewId: null,
  };
}
