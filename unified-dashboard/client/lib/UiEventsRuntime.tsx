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
  useUiEventsEnabled,
  useUiEventTracker,
} from "@seosoyoung/soul-ui";
import { useAuth } from "@seosoyoung/soul-ui/providers";

import { subscribeNavigationUiEvents } from "./ui-events-instrumentation";

/**
 * 대시보드 버전. `vite.config.ts` 의 define 이 package.json 버전을 빌드 타임에 박는다.
 * vitest 처럼 define 이 없는 환경에서만 "dev" 로 떨어진다.
 */
declare const __DASHBOARD_VERSION__: string | undefined;
const APP_VERSION =
  typeof __DASHBOARD_VERSION__ === "string" ? __DASHBOARD_VERSION__ : "dev";

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
  const enabled = useUiEventsEnabled();
  useEffect(() => {
    // 수집이 켜진 뒤에 구독한다. 부팅 직후에 걸면 최초 view_open 이 아직 꺼진
    // 수집기로 들어가 조용히 버려진다 — 매 실행의 첫 화면이 통째로 사라진다.
    // enabled 가 다시 false 가 되면 cleanup 이 먼저 돌아 구독이 겹치지 않는다.
    if (!enabled) return;
    return subscribeNavigationUiEvents(useDashboardStore, track);
  }, [enabled, track]);
  return null;
}
