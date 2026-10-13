import { useCallback, useState } from 'react';
import { Button, useDashboardStore } from '@seosoyoung/soul-ui';
import { PersistentReportProvider } from '@seosoyoung/soul-ui/components/persistent-report/PersistentReportProvider';
import { calculatePersistentSessionLayout } from '@seosoyoung/soul-ui/lib/persistent-session-layout';
import { REPORT_BUBBLE_MINIMUM_HEIGHT } from './use-persistent-session-geometry';
import { PersistentReportDeck, type ReportBubbleSeat } from './PersistentReportDeck';
import { reportReviewEntries } from './persistent-report-review-data';
import './persistent-session-screen.css';

/** Same pager, source entries and PAS reading-column class; all actions stay local. */
export function PersistentReportReviewSample({ bubble = false }: { bubble?: boolean }) {
  const sessionId = bubble ? 'report-review-bubble' : 'report-review';
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  // Same geometry input as the approved 1440×900 PAS screen; no copied deck.
  const layout = calculatePersistentSessionLayout({ app: { left: 0, top: 0, width: 1440, height: 900 }, header: { left: 0, top: 0, width: 1440, height: 76 }, main: { left: 460, top: 76, width: 520, height: 792 }, baselineBottom: 868, inputRowHeight: 32, rowBottomGap: 4, pointerFine: true, showCharacter: true, phoneConfigured: false, reportBubble: { widthScale: 0.8, minimumHeight: REPORT_BUBBLE_MINIMUM_HEIGHT } });
  const seat: ReportBubbleSeat = { target, layout: layout.reportBubble, body: layout.body };
  const [entries, setEntries] = useState(reportReviewEntries);
  const dismiss = useCallback(async (key: string) => setEntries(current => current.filter(entry => entry.key !== key)), []);
  return <PersistentReportProvider sessionId={sessionId} entries={entries}>
    <div className="persistent-session-screen">
      {bubble ? <div style={{ position: 'relative', height: layout.reportBubble!.maxHeight, width: layout.reportBubble!.width }}>
        <div ref={setTarget} className="persistent-session-character" style={{ left: layout.body!.left - layout.reportBubble!.left, top: layout.reportBubble!.maxHeight + layout.body!.top - layout.reportBubble!.bottom, width: layout.body!.width }} />
        <ReviewDeck sessionId={sessionId} seat={seat} dismiss={dismiss} />
      </div> : <main className="persistent-session-main" style={{ height: 'auto' }}><ReviewDeck sessionId={sessionId} dismiss={dismiss} /></main>}
    </div>
    <Button variant="ghost" onClick={() => { useDashboardStore.getState().setPendingChatSend(sessionId, null); setEntries(reportReviewEntries.map(entry => ({ ...entry }))); }}>초기화</Button>
  </PersistentReportProvider>;
}
function ReviewDeck({ sessionId, seat, dismiss }: { sessionId: string; seat?: ReportBubbleSeat; dismiss: (key: string) => Promise<void> }) {
  return <PersistentReportDeck sessionId={sessionId} seat={seat} notify={() => {}} focusInput={() => {}} dismissReport={dismiss}
    transport={async () => { useDashboardStore.getState().setPendingChatSend(sessionId, null); return { ok: true, delivered: true, reason: null, consumeWhen: null }; }} />;
}
