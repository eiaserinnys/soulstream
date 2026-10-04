import type { ApiRequestContext } from './clientCore';

export function createStreamEndpoints({ base }: ApiRequestContext) {
  return {
    // SSE endpoints — URL만 반환한다. 헤더는 useSSEStream이 EventSource options로 주입.
    sessionEventsUrl: (sessionId: string, lastEventId?: string): string => {
      const params = new URLSearchParams({ snapshotCatchup: '1' });
      if (lastEventId) params.set('lastEventId', lastEventId);
      return `${base}/api/sessions/${sessionId}/events?${params.toString()}`;
    },

    // catalog SSE는 Last-Event-ID 기반 replay를 지원한다. feed 화면만 명시적으로
    // feed scope를 요청한다 — 전체 catalog를 쓰는 화면의 계약은 기본값으로 보존한다.
    catalogStreamUrl: (
      lastEventId?: string,
      instanceId?: string,
      scope?: { feedOnly?: boolean },
    ): string => {
      const params = new URLSearchParams({ snapshotCatchup: '1' });
      if (scope?.feedOnly) params.set('feed_only', 'true');
      if (lastEventId) params.set('lastEventId', lastEventId);
      if (instanceId) params.set('instanceId', instanceId);
      const qs = params.toString();
      return `${base}/api/sessions/stream${qs ? `?${qs}` : ''}`;
    },

    nodeStreamUrl: (): string => `${base}/api/nodes/stream`,
  };
}
