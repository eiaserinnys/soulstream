import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ChatView, useDashboardStore, type ChatSessionStoreScope, type PersistentReportEntry } from "@seosoyoung/soul-ui";
import { PersistentReportProvider } from '@seosoyoung/soul-ui/components/persistent-report/PersistentReportProvider';
import { EMPTY_REPORT } from '@seosoyoung/soul-ui/shared/persistent-report';
import type { ChatUiComposerHandle, ChatUiOperationsHandle, RegisterGeneratedTextActions, RegisterChatUiOperations } from '@seosoyoung/soul-ui/components/chat-ui/chat-ui-composer';
import { PersistentReportDeck, type ReportBubbleSeat } from './PersistentReportDeck';
import { usePersistentReportDismiss } from './usePersistentReportDismiss';
import { createPersistentSessionsApi } from "../lib/persistent-sessions";
import { PasCardExpansion, PasCardExpansionStatus } from './PasCardExpansion';

type PersistentSessionChatViewProps = {
  sessionId: string;
  presentation?: "default" | "manuscript";
  composerAnchorRef?: RefObject<HTMLDivElement | null>;
  storeScope?: ChatSessionStoreScope;
  loadDisplaySettings?: boolean;
  showReport?: boolean;
  reportEntries?: PersistentReportEntry[];
  reportSeat?: ReportBubbleSeat;
  dismissReport?: (key: string) => Promise<void>;
} & Omit<NonNullable<Parameters<typeof ChatView>[0]>, "presentation" | "composerAnchorRef">;

export function PersistentSessionChatView({ sessionId, storeScope, loadDisplaySettings = true, showReport = false, reportEntries, reportSeat, dismissReport, ...props }: PersistentSessionChatViewProps) {
  const storedReport = useDashboardStore(state => showReport ? state.persistentReports[sessionId] ?? EMPTY_REPORT : EMPTY_REPORT);
  const entries = reportEntries ?? storedReport;
  const listedSettings = useDashboardStore(state => !storeScope && state.persistentSessionDisplaySettings?.sessionId === sessionId);
  const generated = useRef<ChatUiComposerHandle | null>(null);
  const operations = useRef<ChatUiOperationsHandle | null>(null);
  const registerOperations = useCallback<RegisterChatUiOperations>(handle => { operations.current = handle; }, []);
  const register = useCallback<RegisterGeneratedTextActions>(handle => { generated.current = handle; }, []);
  const notify = useCallback((text: string) => operations.current?.notify(text), []);
  const focusInput = useCallback(() => generated.current?.focusInput?.(), []);
  const getFeedback = useCallback(() => operations.current ?? undefined, []);
  const { dismiss, visibleEntries } = usePersistentReportDismiss(sessionId, getFeedback, dismissReport, entries);
  const setGlobalDisplaySettings = useDashboardStore((state) => state.setPersistentSessionDisplaySettings);
  const setDisplaySettings = storeScope?.store.getState().setPersistentSessionDisplaySettings
    ?? setGlobalDisplaySettings;
  // Null settings can be the final failed result; completion belongs to this lookup.
  const [settledSettingsSession, setSettledSettingsSession] = useState<string | null>(null);
  useEffect(() => {
    if (!loadDisplaySettings) return;
    let active = true;
    setSettledSettingsSession(null);
    const hasSettings = () => (storeScope?.store.getState() ?? useDashboardStore.getState()).persistentSessionDisplaySettings?.sessionId === sessionId;
    if (!hasSettings()) setDisplaySettings(sessionId, null);
    const reportBaseline = useDashboardStore.getState().persistentReports[sessionId];
    void createPersistentSessionsApi().get(sessionId).then(({ session }) => {
      if (!active) return;
      setDisplaySettings(sessionId, session.persistent ? session.settings : null);
      if (session.persistent_report !== undefined) useDashboardStore.getState().setPersistentReport(sessionId, session.persistent_report, { current: reportBaseline });
      setSettledSettingsSession(sessionId);
    }).catch(() => {
      if (active) { if (!hasSettings()) setDisplaySettings(sessionId, null); setSettledSettingsSession(sessionId); }
    });
    return () => { active = false; };
  }, [loadDisplaySettings, sessionId, setDisplaySettings, storeScope]);
  if (!showReport) return <ChatView {...props} storeScope={storeScope} />;
  return <PersistentReportProvider sessionId={sessionId} entries={visibleEntries}>
    {(!loadDisplaySettings || listedSettings || settledSettingsSession === sessionId) && <PersistentReportDeck sessionId={sessionId} notify={notify} disabled={props.chatInputDisabled} seat={reportSeat} focusInput={focusInput} dismissReport={dismiss}
      renderCardDetails={(entry, lookupCards) => <PasCardExpansion key={entry.key} entry={entry} lookupCards={lookupCards} />}
      renderCardStatus={entry => <PasCardExpansionStatus entry={entry} />} />}
    <ChatView {...props} storeScope={storeScope} registerGeneratedTextActions={register} registerChatUiOperations={registerOperations} />
  </PersistentReportProvider>;
}
