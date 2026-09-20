/**
 * 사용 로그 런타임 마운트.
 *
 * AuthGate 안쪽에 두어 사용자가 확정된 뒤에만 수집을 시작한다.
 * 화면 전환 구독은 여기 한 곳에서만 건다.
 */
import { useEffect } from "react";
import type { ReactNode } from "react";

import {
  UiEventsProvider,
  useDashboardStore,
  useUiEventTracker,
} from "@seosoyoung/soul-ui";
import { useAuth } from "@seosoyoung/soul-ui/providers";

import { subscribeNavigationUiEvents } from "./ui-events-instrumentation";

/** 빌드에서 주입되는 대시보드 버전. 없으면 개발 빌드로 본다. */
const APP_VERSION =
  (import.meta.env?.VITE_APP_VERSION as string | undefined) ?? "dev";

export function UiEventsRuntime(props: { readonly children: ReactNode }) {
  const { user } = useAuth();
  return (
    <UiEventsProvider userEmail={user?.email ?? null} appVersion={APP_VERSION}>
      <NavigationUiEvents />
      {props.children}
    </UiEventsProvider>
  );
}

function NavigationUiEvents() {
  const track = useUiEventTracker();
  useEffect(() => subscribeNavigationUiEvents(useDashboardStore, track), [track]);
  return null;
}
