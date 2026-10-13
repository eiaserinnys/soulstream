import { useCallback, useEffect, useRef, type RefObject } from "react";
import { ChatView, useDashboardStore, type ChatSessionStoreScope, type PersistentReportEntry } from "@seosoyoung/soul-ui";
import { PersistentReportProvider } from '@seosoyoung/soul-ui/components/persistent-report/PersistentReportProvider';
import { EMPTY_REPORT } from '@seosoyoung/soul-ui/shared/persistent-report';
import type { ChatUiComposerHandle, ChatUiOperationsHandle, RegisterGeneratedTextActions, RegisterChatUiOperations } from '@seosoyoung/soul-ui/components/chat-ui/chat-ui-composer';
import { PersistentReportDeck } from './PersistentReportDeck';
import { createPersistentSessionsApi } from "../lib/persistent-sessions";

type PersistentSessionChatViewProps = {
  sessionId: string;
  presentation?: "default" | "manuscript";
  composerAnchorRef?: RefObject<HTMLDivElement | null>;
  storeScope?: ChatSessionStoreScope;
  loadDisplaySettings?: boolean;
  showReport?: boolean;
  reportEntries?: PersistentReportEntry[];
  dismissReport?: (key: string) => Promise<void>;
} & Omit<NonNullable<Parameters<typeof ChatView>[0]>, "presentation" | "composerAnchorRef">;

export function PersistentSessionChatView({ sessionId, storeScope, loadDisplaySettings = true, showReport = false, reportEntries, dismissReport, ...props }: PersistentSessionChatViewProps) {
  const storedReport = useDashboardStore(state => showReport ? state.persistentReports[sessionId] ?? EMPTY_REPORT : EMPTY_REPORT);
  const entries = reportEntries ?? storedReport;
  const generated = useRef<ChatUiComposerHandle | null>(null);
  const operations = useRef<ChatUiOperationsHandle | null>(null);
  const registerOperations = useCallback<RegisterChatUiOperations>(handle => { operations.current = handle; }, []);
  const register = useCallback<RegisterGeneratedTextActions>(handle => { generated.current = handle; }, []);
  const append = useCallback<ChatUiComposerHandle['appendGeneratedText']>((id, text) => operations.current?.appendGeneratedText(id, text) ?? { ok: false, reason: 'unavailable' }, []);
  const focusInput = useCallback(() => generated.current?.focusInput?.(), []);
  const dismiss = useCallback(async (key: string) => {
    const started = operations.current;
    const state = useDashboardStore.getState();
    const before = state.persistentReports[sessionId] ?? EMPTY_REPORT;
    try {
      if (dismissReport) { await dismissReport(key); return; }
      const result = await createPersistentSessionsApi().dismissReport(sessionId, key);
      state.setPersistentReport(sessionId, result.persistent_report, { current: before });
    } catch {
      started?.notify('보고를 내리지 못했어.');
    }
  }, [dismissReport, sessionId]);
  const setGlobalDisplaySettings = useDashboardStore((state) => state.setPersistentSessionDisplaySettings);
  const setDisplaySettings = storeScope?.store.getState().setPersistentSessionDisplaySettings
    ?? setGlobalDisplaySettings;
  useEffect(() => {
    if (!loadDisplaySettings) return;
    let active = true;
    setDisplaySettings(sessionId, null);
    const reportBaseline = useDashboardStore.getState().persistentReports[sessionId];
    void createPersistentSessionsApi().get(sessionId).then(({ session }) => {
      if (!active) return;
      setDisplaySettings(sessionId, session.persistent ? session.settings : null);
      if (session.persistent_report !== undefined) useDashboardStore.getState().setPersistentReport(sessionId, session.persistent_report, { current: reportBaseline });
    }).catch(() => {
      if (active) setDisplaySettings(sessionId, null);
    });
    return () => { active = false; };
  }, [loadDisplaySettings, sessionId, setDisplaySettings]);
  if (!showReport) return <ChatView {...props} storeScope={storeScope} />;
  return <PersistentReportProvider sessionId={sessionId} entries={entries}>
    <PersistentReportDeck sessionId={sessionId} appendGeneratedText={append} focusInput={focusInput} dismissReport={dismiss} />
    <ChatView {...props} storeScope={storeScope} registerGeneratedTextActions={register} registerChatUiOperations={registerOperations} />
  </PersistentReportProvider>;
}
