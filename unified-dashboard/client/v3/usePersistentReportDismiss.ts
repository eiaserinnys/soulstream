import { useCallback, useMemo, useReducer, useRef } from 'react';
import { useDashboardStore, type PersistentReportEntry } from '@seosoyoung/soul-ui';
import { EMPTY_REPORT } from '@seosoyoung/soul-ui/shared/persistent-report';
import type { ChatUiOperationsHandle } from '@seosoyoung/soul-ui/components/chat-ui/chat-ui-composer';
import { createPersistentSessionsApi } from '../lib/persistent-sessions';

const DISMISS_FAILED = '보고를 내리지 못했어.';
type Publication = { sessionId: string; key: string; updatedAt: string };
const samePublication = (sessionId: string, entry: PersistentReportEntry, publication?: Publication) =>
  publication?.sessionId === sessionId && publication.key === entry.key && publication.updatedAt === entry.updated_at;
/** Pending keys hide their source publication; canonical REST/SSE entries stay intact. */
export function usePersistentReportDismiss(sessionId: string, getFeedback: () => Pick<ChatUiOperationsHandle, 'notify' | 'clearFeedback'> | undefined, customDismiss?: (key: string) => Promise<void>, entriesOverride?: PersistentReportEntry[]) {
  const stored = useDashboardStore(state => state.persistentReports[sessionId] ?? EMPTY_REPORT);
  const entries = entriesOverride ?? stored;
  const requests = useRef(new Map<string, Publication>());
  const [version, refresh] = useReducer(value => value + 1, 0);
  const dismiss = useCallback(async (key: string) => {
    const id = JSON.stringify([sessionId, key]);
    if (requests.current.has(id)) return;
    const source = entries.find(entry => entry.key === key);
    if (!source) return;
    const feedback = getFeedback();
    const publication = { sessionId, key, updatedAt: source.updated_at };
    requests.current.set(id, publication); refresh();
    try {
      if (customDismiss) await customDismiss(key);
      else {
        await createPersistentSessionsApi().dismissReport(sessionId, key);
        const state = useDashboardStore.getState();
        const current = state.persistentReports[sessionId];
        // A newer publication of this key survives an old acknowledgement.
        if (current?.some(entry => samePublication(sessionId, entry, publication))) {
          state.setPersistentReport(sessionId, current.filter(entry => !samePublication(sessionId, entry, publication)));
        }
      }
      feedback?.clearFeedback(DISMISS_FAILED);
    } catch {
      feedback?.notify(DISMISS_FAILED);
    } finally {
      requests.current.delete(id); refresh();
    }
  }, [sessionId, entries, getFeedback, customDismiss]);
  const visibleEntries = useMemo(() => entries.filter(entry => !samePublication(sessionId, entry, requests.current.get(JSON.stringify([sessionId, entry.key])))), [entries, sessionId, version]);
  const pending = new Set([...requests.current.values()].filter(request => request.sessionId === sessionId).map(request => request.key));
  return { dismiss, pending, visibleEntries };
}
