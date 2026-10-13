import { useCallback, useReducer, useRef } from 'react';
import { useDashboardStore } from '@seosoyoung/soul-ui';
import { createPersistentSessionsApi } from '../lib/persistent-sessions';

/** A DELETE acknowledges only its key. Full boards continue to come from REST/SSE. */
export function usePersistentReportDismiss(sessionId: string, getNotify: () => ((text: string) => void) | undefined, customDismiss?: (key: string) => Promise<void>) {
  const requests = useRef(new Set<string>());
  const [, refresh] = useReducer(value => value + 1, 0);
  const dismiss = useCallback(async (key: string) => {
    const id = JSON.stringify([sessionId, key]);
    if (requests.current.has(id)) return;
    const source = useDashboardStore.getState().persistentReports[sessionId]?.find(entry => entry.key === key);
    if (!source && !customDismiss) return;
    const notify = getNotify();
    requests.current.add(id); refresh();
    try {
      if (customDismiss) await customDismiss(key);
      else {
        await createPersistentSessionsApi().dismissReport(sessionId, key);
        const state = useDashboardStore.getState();
        const current = state.persistentReports[sessionId];
        // A newer publication of this key survives an old acknowledgement.
        if (current?.includes(source!)) state.setPersistentReport(sessionId, current.filter(entry => entry !== source));
      }
    } catch {
      notify?.('보고를 내리지 못했어.');
    } finally {
      requests.current.delete(id); refresh();
    }
  }, [sessionId, getNotify, customDismiss]);
  const pending = new Set([...requests.current].map(id => JSON.parse(id) as [string, string]).filter(([owner]) => owner === sessionId).map(([, key]) => key));
  return { dismiss, pending };
}
