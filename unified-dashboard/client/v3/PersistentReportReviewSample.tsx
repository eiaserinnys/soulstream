import { useCallback, useEffect, useState } from 'react';
import { Button, useDashboardStore } from '@seosoyoung/soul-ui';
import type { PersistentReportEntry } from '@seosoyoung/soul-ui';
import { PersistentReportProvider } from '@seosoyoung/soul-ui/components/persistent-report/PersistentReportProvider';
import { calculatePersistentSessionLayout } from '@seosoyoung/soul-ui/lib/persistent-session-layout';
import { REPORT_BUBBLE_MINIMUM_HEIGHT } from './use-persistent-session-geometry';
import { PersistentReportDeck, type ReportBubbleSeat } from './PersistentReportDeck';
import { PasCardPreview, PasCardPreviewStatus, pasPreviewCard, pasPreviewEntries, pasSecondPreviewCard } from './PasCardPreview';
import { useCardStore } from '@seosoyoung/soul-ui/cards/card-store';
import { reportReviewEntries } from './persistent-report-review-data';
import './persistent-session-screen.css';

export type CompletionSample = 'review' | 'blocked' | 'undo' | 'undo-only';
type CompletionSampleEntry = PersistentReportEntry & { card_id?: string; card_status?: string };
const reviewCompletionEntry: CompletionSampleEntry = pasPreviewEntries[0]!;
const secondReviewCompletionEntry: CompletionSampleEntry = {
  ...reviewCompletionEntry, key: 'card_preview-pas-card-2', card_id: 'preview-pas-card-2', card_numbers: [532],
  title: '두 번째 검수 카드 장', context: '먼저 완료한 카드는 숨김으로 남습니다.', updated_at: 'second-preview',
};
const blockedCompletionEntry: CompletionSampleEntry = {
  ...reviewCompletionEntry, key: 'card_preview-blocked', title: '막힘 카드 장', card_numbers: [], card_id: undefined,
  card_status: 'blocked', context: '막힌 카드의 기존 확인 동작을 유지합니다.', updated_at: 'blocked-preview',
};
const nextCompletionEntry: CompletionSampleEntry = {
  ...reviewCompletionEntry, key: 'preview-next-report', title: '다음 보고 장', card_numbers: [], card_id: undefined, card_status: undefined,
  kind: 'see', context: '다음 보고도 같은 판에 남아 있습니다.', action: '', updated_at: 'next-preview',
};
const completionSampleEntries: Record<CompletionSample, CompletionSampleEntry[]> = {
  review: [reviewCompletionEntry],
  blocked: [blockedCompletionEntry],
  undo: [reviewCompletionEntry, secondReviewCompletionEntry, blockedCompletionEntry, nextCompletionEntry],
  'undo-only': [reviewCompletionEntry],
};

/** Same pager, source entries and PAS reading-column class; all actions stay local. */
export function PersistentReportReviewSample({ bubble = false, cardPreview = false, before = false, completionScenario }: { bubble?: boolean; cardPreview?: boolean; before?: boolean; completionScenario?: CompletionSample }) {
  const sessionId = bubble ? 'report-review-bubble' : 'report-review';
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  // Same geometry input as the approved 1440×900 PAS screen; no copied deck.
  const layout = calculatePersistentSessionLayout({ app: { left: 0, top: 0, width: 1440, height: 900 }, header: { left: 0, top: 0, width: 1440, height: 76 }, main: { left: 460, top: 76, width: 520, height: 792 }, baselineBottom: 868, inputRowHeight: 32, rowBottomGap: 4, pointerFine: true, showCharacter: true, phoneConfigured: false, reportBubble: { widthScale: 0.8, minimumHeight: REPORT_BUBBLE_MINIMUM_HEIGHT } });
  const seat: ReportBubbleSeat = { target, layout: layout.reportBubble, body: layout.body };
  const source = completionScenario ? completionSampleEntries[completionScenario] : cardPreview ? pasPreviewEntries : reportReviewEntries;
  const [entries, setEntries] = useState(source);
  const previewEnabled = cardPreview || Boolean(completionScenario);
  const [deckVersion, setDeckVersion] = useState(0);
  useEffect(() => { if (previewEnabled) useCardStore.getState().putCards([pasPreviewCard, pasSecondPreviewCard]); }, [previewEnabled]);
  const preview = previewEnabled && !before ? { renderCardStatus: (entry: typeof source[number]) => <PasCardPreviewStatus entry={entry} />, renderCardDetails: (entry: typeof source[number], lookupCards: () => Promise<void>) => !completionScenario || entry.key === reviewCompletionEntry.key || entry.key === secondReviewCompletionEntry.key ? <PasCardPreview key={entry.key} entry={entry} lookupCards={lookupCards} onAnswer={answer => setEntries(current => current.map(item => item.key === entry.key ? { ...item, answer, state: 'answered', updated_at: 'preview-answer' } : item))} /> : null } : {};
  const dismiss = useCallback(async (key: string) => setEntries(current => current.filter(entry => entry.key !== key)), []);
  const cardTransition = useCallback(async (cardId: string, status: 'done' | 'on_hold' | 'review') => {
    const key = `card_${cardId}`;
    if (status === 'done' || status === 'on_hold') setEntries(current => current.filter(entry => entry.key !== key));
    else setEntries(current => {
      if (current.some(entry => entry.key === key)) return current;
      const restored = source.find(entry => entry.key === key);
      if (!restored) return current;
      const sourceIndex = source.findIndex(entry => entry.key === key);
      let insertAt = sourceIndex === 0 ? 0 : current.length;
      for (let index = sourceIndex + 1; index < source.length; index += 1) {
        const anchor = current.findIndex(entry => entry.key === source[index]!.key);
        if (anchor >= 0) { insertAt = anchor; break; }
      }
      const restoredEntry = { ...restored, card_status: 'review', updated_at: `preview-restored-${cardId}` };
      return [...current.slice(0, insertAt), restoredEntry, ...current.slice(insertAt)];
    });
  }, [source]);
  return <PersistentReportProvider sessionId={sessionId} entries={entries}>
    <div className="persistent-session-screen">
      {bubble ? <div style={{ position: 'relative', height: layout.reportBubble!.maxHeight, width: layout.reportBubble!.width }}>
        <div ref={setTarget} className="persistent-session-character" style={{ left: layout.body!.left - layout.reportBubble!.left, top: layout.reportBubble!.maxHeight + layout.body!.top - layout.reportBubble!.bottom, width: layout.body!.width }} />
        <ReviewDeck key={deckVersion} sessionId={sessionId} seat={seat} dismiss={dismiss} cardTransition={completionScenario ? cardTransition : undefined} {...preview} />
      </div> : <main className="persistent-session-main" style={{ height: 'auto' }}><ReviewDeck key={deckVersion} sessionId={sessionId} dismiss={dismiss} cardTransition={completionScenario ? cardTransition : undefined} {...preview} /></main>}
    </div>
    <Button variant="ghost" onClick={() => { useDashboardStore.getState().setPendingChatSend(sessionId, null); setEntries(source.map(entry => ({ ...entry }))); setDeckVersion(value => value + 1); }}>초기화</Button>
  </PersistentReportProvider>;
}
function ReviewDeck({ sessionId, seat, dismiss, cardTransition, ...preview }: Pick<React.ComponentProps<typeof PersistentReportDeck>, "renderCardDetails" | "renderCardStatus" | "cardTransition"> & { sessionId: string; seat?: ReportBubbleSeat; dismiss: (key: string) => Promise<void> }) {
  const pending = useDashboardStore(state => state.pendingChatSends[sessionId]);
  useEffect(() => { if (pending?.persistentReportOperation?.acknowledged) useDashboardStore.getState().setPendingChatSend(sessionId, null); }, [pending, sessionId]);
  return <PersistentReportDeck {...preview} sessionId={sessionId} seat={seat} notify={() => {}} focusInput={() => {}} dismissReport={dismiss}
    cardTransition={cardTransition}
    transport={async () => { return { ok: true, delivered: true, reason: null, consumeWhen: null }; }} />;
}
