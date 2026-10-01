import { useCallback, useRef } from 'react';
import {
  recordUiUsageEvent,
  type UiEventEntry,
  type UiEventTarget,
  type UiUsageEventInput,
} from '../lib/ui-usage-events';

type NavigationNode = {
  index?: number;
  routes?: Array<{
    name?: string;
    params?: Record<string, unknown>;
    state?: NavigationNode;
  }>;
};
type NavigationRoute = NonNullable<NavigationNode['routes']>[number];
type RecordUiUsageEvent = (input: UiUsageEventInput) => boolean;

/** NavigationContainer의 phone 화면 전환을 수집 가능한 때만 기억한다. */
export function useNavigationViewUsageEvents(
  record: RecordUiUsageEvent = recordUiUsageEvent,
) {
  const lastViewRef = useRef<UiEventTarget | null>(null);

  const recordNavigationView = useCallback((state: unknown, initial: boolean): boolean => {
    const target = activeNavigationTarget(state);
    if (!target) return false;
    const previous = lastViewRef.current;
    if (previous?.kind === target.kind && previous.id === target.id) return false;
    const accepted = record({
      type: 'view_open',
      target,
      from: previous,
      entry: initial
        ? 'auto'
        : navigationEntry(state) ?? entryForNavigation(previous),
    });
    if (accepted) lastViewRef.current = target;
    return accepted;
  }, [record]);

  const snapshotNavigationView = useCallback((state: unknown): boolean => {
    // 수집이 꺼진 사이의 출발 화면은 관측하지 않았으므로 추정하지 않는다.
    lastViewRef.current = null;
    return recordNavigationView(state, true);
  }, [recordNavigationView]);

  return { recordNavigationView, snapshotNavigationView };
}

function activeNavigationTarget(state: unknown): UiEventTarget | null {
  let current = state as NavigationNode | undefined;
  let route: NavigationRoute | undefined;
  while (current?.routes?.length) {
    route = current.routes[current.index ?? 0];
    if (!route) return null;
    if (!route.state) break;
    current = route.state;
  }
  if (!route?.name) return null;
  const params = route.params ?? {};
  if (typeof params.sessionId === 'string') return { kind: 'session', id: params.sessionId };
  if (typeof params.folderPageId === 'string') return { kind: 'page', id: params.folderPageId };
  if (typeof params.projectPageId === 'string') return { kind: 'page', id: params.projectPageId };
  return { kind: 'view', id: route.name };
}

function entryForNavigation(previous: UiEventTarget | null): UiEventEntry {
  if (previous?.kind === 'view' && previous.id === 'Search') return 'search';
  if (previous?.kind === 'view' && previous.id === 'Feed') return 'feed';
  return 'nav';
}

function navigationEntry(state: unknown): UiEventEntry | null {
  const route = deepestNavigationRoute(state as NavigationNode | undefined);
  return route?.params?.usageEntry === 'notification' ? 'notification' : null;
}

function deepestNavigationRoute(
  state: NavigationNode | undefined,
): NavigationRoute | undefined {
  let current = state;
  let route: NavigationRoute | undefined;
  while (current?.routes?.length) {
    route = current.routes[current.index ?? 0];
    if (!route?.state) return route;
    current = route.state;
  }
  return route;
}
