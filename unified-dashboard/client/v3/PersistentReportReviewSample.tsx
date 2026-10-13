import { useCallback, useRef, useState } from 'react';
import { Button, useDashboardStore } from '@seosoyoung/soul-ui';
import { PersistentReportProvider, usePersistentReport } from '@seosoyoung/soul-ui/components/persistent-report/PersistentReportProvider';
import { PersistentReportDeck } from './PersistentReportDeck';
import { reportReviewEntries } from './persistent-report-review-data';
import './persistent-session-screen.css';

/** Same pager, source entries and PAS reading-column class; all actions stay local. */
export function PersistentReportReviewSample() {
  const [entries, setEntries] = useState(reportReviewEntries);
  const dismiss = useCallback(async (key: string) => setEntries(current => current.filter(entry => entry.key !== key)), []);
  return <PersistentReportProvider sessionId="report-review" entries={entries}>
    <div className="persistent-session-screen">
      <main className="persistent-session-main" style={{ height: 'auto' }}><ReviewDeck dismiss={dismiss} /></main>
    </div>
    <Button variant="ghost" onClick={() => { useDashboardStore.getState().setPendingChatSend('report-review', null); setEntries(reportReviewEntries.map(entry => ({ ...entry }))); }}>초기화</Button>
  </PersistentReportProvider>;
}
function ReviewDeck({ dismiss }: { dismiss: (key: string) => Promise<void> }) {
  const report = usePersistentReport()!;
  const draft = useRef('');
  return <>
    <PersistentReportDeck sessionId="report-review" appendGeneratedText={(_sessionId, text) => { draft.current = text; return { ok: true }; }} focusInput={() => {}} dismissReport={dismiss} />
    <div className="chat-ui-actions">
      <Button variant="ghost" onClick={() => useDashboardStore.getState().setPendingChatSend('report-review', { id: 'review-send', status: 'sending', text: draft.current, messageText: draft.current, attachmentPaths: [], attachments: [], mode: 'intervention', ...report.getMessageContext(draft.current) })}>전송 상태</Button>
      <Button variant="ghost" onClick={() => { const pending = useDashboardStore.getState().pendingChatSends['report-review']; if (pending) useDashboardStore.getState().setPendingChatSend('report-review', { ...pending, status: 'failed' }); }}>실패 상태</Button>
    </div>
  </>;
}
