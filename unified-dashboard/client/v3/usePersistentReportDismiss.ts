import { useTranslation } from "react-i18next";
import { useCallback, useMemo, useReducer, useRef } from 'react';
import { useDashboardStore } from '@seosoyoung/soul-ui';
import { EMPTY_REPORT, type PersistentReportEntry } from '../../../packages/wire-schema/src/persistent_report';
import type { ChatUiOperationsHandle } from '@seosoyoung/soul-ui/components/chat-ui/chat-ui-composer';
import { createPersistentSessionsApi } from '../lib/persistent-sessions';

type Publication = { sessionId: string; key: string; updatedAt: string };
const samePublication = (sessionId: string, entry: PersistentReportEntry, publication?: Publication) =>
  publication?.sessionId === sessionId && publication.key === entry.key && publication.updatedAt === entry.updated_at;
/** Pending keys hide their source publication; canonical REST/SSE entries stay intact. */
export function usePersistentReportDismiss(sessionId: string, getFeedback: () => Pick<ChatUiOperationsHandle, 'notify' | 'clearFeedback'> | undefined, customDismiss?: (key: string) => Promise<void>, entriesOverride?: PersistentReportEntry[]) {
  const { t, i18n } = useTranslation();
  const api = useMemo(() => createPersistentSessionsApi(fetch, i18n.t), [i18n]);
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
    const dismissFailed = t("persistent.report.dismissFailed");
    const publication = { sessionId, key, updatedAt: source.updated_at };
    requests.current.set(id, publication); refresh();
    try {
      if (customDismiss) await customDismiss(key);
      else {
        await api.dismissReport(sessionId, key);
        const state = useDashboardStore.getState();
        const current = state.persistentReports[sessionId];
        // A newer publication of this key survives an old acknowledgement.
        if (current?.some(entry => samePublication(sessionId, entry, publication))) {
          state.setPersistentReport(sessionId, current.filter(entry => !samePublication(sessionId, entry, publication)));
        }
      }
      feedback?.clearFeedback(dismissFailed);
    } catch {
      feedback?.notify(dismissFailed);
    } finally {
      requests.current.delete(id); refresh();
    }
  }, [sessionId, entries, getFeedback, customDismiss, api, t]);
  const visibleEntries = useMemo(() => entries.filter(entry => !samePublication(sessionId, entry, requests.current.get(JSON.stringify([sessionId, entry.key])))), [entries, sessionId, version]);
  const pending = new Set([...requests.current.values()].filter(request => request.sessionId === sessionId).map(request => request.key));
  return { dismiss, pending, visibleEntries };
}
