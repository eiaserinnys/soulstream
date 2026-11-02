import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, DashboardIconCap, type PersistentReportEntry } from '@seosoyoung/soul-ui';
import { SourceLink } from '@seosoyoung/soul-ui/components/SourceLink';
import { usePersistentReport } from '@seosoyoung/soul-ui/components/persistent-report/PersistentReportProvider';
import { createPortal } from 'react-dom';
import type { PersistentSessionReportBubbleLayout, PersistentSessionRect } from '@seosoyoung/soul-ui/lib/persistent-session-layout';
import { submitIntervention } from '@seosoyoung/soul-ui/components/chat/submitIntervention';
import { usePersistentReportSend } from './usePersistentReportSend';
import { useReportDeckHeight } from './useReportDeckHeight';
import { CARD_COMPLETION_UNDO_MS, usePersistentCardCompletion, type CardTransition } from './usePersistentCardCompletion';
import { UndoCountdownRing } from './UndoCountdownRing';
import { ChevronLeft, ChevronRight, Link, Maximize2, Minimize2 } from 'lucide-react';
import { useCardStore } from '@seosoyoung/soul-ui/cards/card-store';
import { cardRequest } from '@seosoyoung/soul-ui/cards/card-api';
import type { CardRow } from '@seosoyoung/soul-ui/cards/card-types';
import '@seosoyoung/soul-ui/components/chat-ui/chat-ui.css';
import './persistent-report.css';

export type ReportBubbleSeat = { target: HTMLElement | null; layout: PersistentSessionReportBubbleLayout | null; body: PersistentSessionRect | null; ready?: boolean; inlineWidth?: number; inlineMaxHeight?: number };
type Props = { renderCardDetails?(entry: PersistentReportEntry, lookupCards: () => Promise<void>): React.ReactNode; renderCardStatus?(entry: PersistentReportEntry): React.ReactNode; sessionId: string; focusInput: () => void; dismissReport: (key: string) => Promise<void>; notify: (text: string) => void; disabled?: boolean; seat?: ReportBubbleSeat; transport?: typeof submitIntervention; cardTransition?: CardTransition; completion?: ReturnType<typeof usePersistentCardCompletion> };
type ReportCardEntry = PersistentReportEntry & { card_id?: string; card_status?: string };
const LINK_FOCUS = 'rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background';

export function PersistentReportDeck({ sessionId, focusInput, dismissReport, notify, disabled = false, seat, transport, renderCardDetails, renderCardStatus, cardTransition, completion: providedCompletion }: Props) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [localVisibleKey, setLocalVisibleKey] = useState<string | null>(null);
  const report = usePersistentReport()!;
  const { entries: rawEntries, visibleKey } = report;
  const sending = usePersistentReportSend(sessionId, notify, transport);
  const localCompletion = usePersistentCardCompletion(notify, cardTransition);
  const completion = providedCompletion ?? localCompletion;
  const entries = useMemo(() => completion.filterEntries(rawEntries), [completion.filterEntries, completion.revision, rawEntries]);
  const effectiveVisibleKey = localVisibleKey && entries.some(entry => entry.key === localVisibleKey) && !rawEntries.some(entry => entry.key === localVisibleKey)
    ? localVisibleKey
    : visibleKey;
  const selectKey = useCallback((key: string) => { setLocalVisibleKey(key); report.view(key); }, [report]);
  const pendingCardNumbers = useRef(new Set<number>()).current;
  const byId = useCardStore(state => state.byId);
  const numbers = [...new Set(entries.flatMap(entry => entry.card_numbers))].sort((a, b) => a - b);
  const numbersKey = JSON.stringify(numbers);
  const lookupScope = useRef({ key: numbersKey, numbers, missing: new Set<number>() });
  if (lookupScope.current.key !== numbersKey) lookupScope.current = { key: numbersKey, numbers, missing: new Set() };
  const pendingLookup = useRef<Promise<void> | null>(null);
  const lookupCards = useCallback(() => {
    if (pendingLookup.current) return pendingLookup.current;
    const lookup = (async () => {
      try {
        const { cards } = await cardRequest<{ cards: CardRow[] }>('/api/cards?includeCompleted=true');
        const store = useCardStore.getState();
        store.putCards(cards.filter(card => !store.byId[card.id] || store.byId[card.id].version <= card.version));
        const known = new Set(Object.values(useCardStore.getState().byId).map(card => card.number));
        lookupScope.current.missing = new Set(lookupScope.current.numbers.filter(number => !known.has(number)));
      } catch { /* A failed lookup stays retryable, without a new error surface. */ }
    })().finally(() => { pendingLookup.current = null; });
    pendingLookup.current = lookup;
    return lookup;
  }, []);
  useEffect(() => {
    const known = new Set(Object.values(byId).map(card => card.number));
    if (lookupScope.current.numbers.some(number => !known.has(number) && !lookupScope.current.missing.has(number))) void lookupCards();
  }, [byId, numbersKey, lookupCards]);
  const index = Math.max(0, entries.findIndex(entry => entry.key === effectiveVisibleKey));
  const currentKey = entries[index]?.key ?? null;
  const activeExpandedKey = expandedKey === currentKey ? expandedKey : null;
  const track = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement | null>(null);
  const bubble = seat?.target && seat.body ? seat.layout : null;
  const inBubble = Boolean(bubble);
  const ready = seat?.ready !== false;
  const measurementRevision = JSON.stringify([activeExpandedKey, completion.recent, entries.map(entry => {
    const cardEntry = entry as ReportCardEntry;
    return [entry.key, entry.updated_at, entry.title, entry.context, entry.action, entry.options, entry.card_numbers, cardEntry.card_id, cardEntry.card_status];
  })]);
  const inlineMaxHeight = bubble ? undefined : seat?.inlineMaxHeight;
  const maximumHeight = bubble?.maxHeight ?? inlineMaxHeight;
  const layoutKey = JSON.stringify([sessionId, inBubble, bubble?.width ?? seat?.inlineWidth, maximumHeight, ready, activeExpandedKey, entries.length > 0 || Boolean(completion.recent)]);
  const sizing = useReportDeckHeight(root, measurementRevision, sessionId, layoutKey, maximumHeight);
  const focusWithin = useRef(false);
  const flying = useRef<number | null>(null);
  useEffect(() => {
    const focused = (event: FocusEvent) => {
      // A removed button can leave focus on body without a blur. Observe the
      // next real destination, using the actual portal DOM rather than its parent.
      if (event.target instanceof Node && event.target !== document.body && !root.current?.contains(event.target)) focusWithin.current = false;
    };
    document.addEventListener('focusin', focused);
    return () => document.removeEventListener('focusin', focused);
  }, []);
  const current = useRef({ index });
  current.current = { index };
  useEffect(() => { setLocalVisibleKey(null); }, [visibleKey]);
  useEffect(() => { setExpandedKey(null); }, [effectiveVisibleKey]);
  const entriesKey = entries.map(entry => entry.key).join('\0');
  const prevEntriesKey = useRef(entriesKey);

  const go = (target: number) => {
    const node = track.current;
    const at = Math.max(0, Math.min(entries.length - 1, target));
    if (!node || at === index) return;
    if ((at === 0 || at === entries.length - 1) && document.activeElement?.closest('.pas-report-nav')) node.focus({ preventScroll: true });
    sizing.startScroll();
    flying.current = at;
    selectKey(entries[at].key);
    node.scrollTo({ left: at * node.clientWidth, behavior: 'smooth' });
  };
  useLayoutEffect(() => {
    const node = track.current;
    if (!node) return;
    // A sheet that left optimistically can leave the deck holding a scroll or
    // press lock from its own navigation; release it before realigning.
    if (prevEntriesKey.current !== entriesKey) { prevEntriesKey.current = entriesKey; flying.current = null; sizing.endScroll(); }
    const align = () => { if (sizing.holding.current) return; flying.current = null; node.scrollTo({ left: current.current.index * node.clientWidth, behavior: 'auto' }); };
    align();
    const observer = new ResizeObserver(align);
    observer.observe(node);
    return () => observer.disconnect();
  }, [entries, entriesKey, sessionId, inBubble, ready]);
  useLayoutEffect(() => {
    if (!focusWithin.current || !root.current) return;
    // A removed section still contains its old children in the retained ref.
    // An empty board must focus the composer instead of querying that detached subtree.
    if (!entries.length) { focusWithin.current = false; focusInput(); return; }
    const active = document.activeElement;
    const sheet = root.current.querySelector<HTMLElement>('[data-current="true"]');
    if (sheet?.contains(active) || (root.current.contains(active) && !active?.closest('.pas-report-sheet'))) return;
    if (sheet) sheet.focus({ preventScroll: true });
  }, [effectiveVisibleKey, entries.length, focusInput]);

  if (!ready || (!entries.length && !completion.recent)) return null;
  // The global reduced-motion duration must not interpolate the initial font
  // gate's opacity or measured height for a frame.
  const deck = <section ref={node => { if (node) root.current = node; }} className="pas-report" data-bubble={Boolean(bubble)} data-inline-max-height={inlineMaxHeight !== undefined || undefined} data-overflow={sizing.overflowing} data-undo={Boolean(completion.recent) || undefined} style={{ transitionProperty: 'none', opacity: sizing.waitingForFont ? 0 : undefined, height: sizing.height, maxHeight: bubble?.maxHeight, ...(inlineMaxHeight !== undefined ? { '--pas-report-inline-max-height': `${inlineMaxHeight}px` } : {}), ...(bubble && seat?.body ? { position: 'absolute', left: bubble.left - seat.body.left, top: bubble.bottom - seat.body.top, width: bubble.width, transform: 'translateY(-100%)', '--pas-report-tail-left': `${bubble.tailLeft}px` } : {}) } as React.CSSProperties} data-testid="report-deck" data-many={entries.length > 1}
    inert={sizing.waitingForFont || undefined} aria-hidden={sizing.waitingForFont || undefined} aria-label="지금의 보고" aria-roledescription="carousel"
    onPointerDownCapture={sizing.hold}
    onFocusCapture={() => { focusWithin.current = true; }}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null) && (event.relatedTarget || event.target.isConnected)) focusWithin.current = false; }}
    onKeyDown={event => { if (renderCardDetails && (event.target as Element).closest('input,textarea,[contenteditable=true]')) return; if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); go(index + (event.key === 'ArrowRight' ? 1 : -1)); } }}>
    <div ref={track} className="pas-report-track" data-testid="report-track" tabIndex={entries.length > 1 ? 0 : -1} role="group" aria-label="보고 장. 좌우 화살표로 넘깁니다"
      onScroll={event => {
        const node = event.currentTarget;
        sizing.startScroll();
        const at = Math.round(node.scrollLeft / Math.max(1, node.clientWidth));
        // Completing a later sheet shortens the track; a flight target beyond
        // the new end must not keep the height lock forever.
        if (entries.length <= 1 || (flying.current !== null && flying.current >= entries.length)) { flying.current = null; sizing.endScroll(); }
        if (flying.current !== null) { if (at !== flying.current) return; flying.current = null; }
        if (entries[at]) selectKey(entries[at].key);
        if (Math.abs(node.scrollLeft - at * node.clientWidth) < 0.5) sizing.endScroll();
      }}
      onScrollEnd={event => {
        flying.current = null;
        const at = Math.round(event.currentTarget.scrollLeft / Math.max(1, event.currentTarget.clientWidth));
        if (entries[at]) selectKey(entries[at].key);
        sizing.endScroll();
      }}>
      {!entries.length && completion.recent ? <article className="pas-report-sheet" data-current="true" data-undo-only data-publication={JSON.stringify([sessionId, 'undo', completion.recent.cardId])}>
        <div className="pas-report-reading"><div className="pas-report-content" /></div>
        <div className="pas-report-undo"><span className="pas-report-received-label">{completion.recent.label}</span><Button variant="ghost" size="xs" disabled={completion.busy} onClick={() => void completion.undo()}><UndoCountdownRing key={`${completion.recent.cardId}-${completion.recent.expiresAt}`} expiresAt={completion.recent.expiresAt} durationMs={CARD_COMPLETION_UNDO_MS}/>되돌리기</Button></div>
      </article> : entries.map((entry, position) => {
        const cardEntry = entry as ReportCardEntry;
        const completionEligible = entry.key.startsWith('card_') && cardEntry.card_status === 'review' && Boolean(cardEntry.card_id);
        const expandable = Boolean(renderCardDetails && (cardEntry.card_id || entry.card_numbers.length === 1));
        const expanded = expandable && activeExpandedKey === entry.key;
        const toggle = () => setExpandedKey(expanded ? null : entry.key);
        const answer = report.answer(entry);
        const answered = answer !== undefined;
        const suppressActions = answered && !completionEligible;
        const acknowledgeable = entry.kind === 'see' || (entry.kind === 'ask' && entry.options.length === 0 && !answered);
        const tag = entry.kind === 'see' ? '보실 것' : answered ? '답 받음' : '답하실 것';
        return <article key={entry.key} className="pas-report-sheet" data-testid={`report-sheet-${entry.key}`} data-current={position === index}
          data-answered={answered} data-publication={JSON.stringify([sessionId, entry.key, expanded, entry.title, entry.context, entry.action, entry.options, entry.card_numbers, cardEntry.card_id, cardEntry.card_status])} inert={position !== index} aria-hidden={position !== index} tabIndex={-1} aria-roledescription="slide"
          aria-label={`${entries.length > 1 ? `${position + 1} / ${entries.length}, ` : ''}${tag}, ${entry.title}`}>
          <div className="pas-report-reading v3-session-panel-scroll" onScroll={event => {
            const node = event.currentTarget;
            node.dataset.more = String(node.scrollHeight - node.scrollTop - node.clientHeight > 1);
          }} ref={node => { if (node) node.dataset.more = String(node.scrollHeight - node.scrollTop - node.clientHeight > 1); }}>
            <div className="pas-report-content">
              <div className="pas-report-heading" data-window={expandable || undefined}>
                <div className="pas-report-heading-main">
                  <h2 className="pas-report-title">{expandable ? <button type="button" className="pas-report-expand" aria-expanded={expanded} onClick={toggle}>{entry.title}</button> : entry.title}</h2>
                  {entry.card_numbers.map(number => <ReportCardLink key={number} number={number} pending={pendingCardNumbers} lookupCards={lookupCards} />)}
                  {renderCardStatus?.(entry)}
                </div>
                {expandable && <DashboardIconCap size="small" className="pas-report-window" label={expanded ? '축소' : '확대'} aria-expanded={expanded} onClick={toggle}>
                  {expanded ? <Minimize2 className="h-4 w-4" aria-hidden="true" /> : <Maximize2 className="h-4 w-4" aria-hidden="true" />}
                </DashboardIconCap>}
              </div>
              {(!expanded || entry.kind === 'ask') && <p className="pas-report-context" onClick={expandable ? toggle : undefined}>{entry.context}</p>}
              {!answered && entry.action !== '' && <p className="pas-report-todo"><ReportAction text={entry.action} /></p>}
              {expanded && renderCardDetails?.(entry, lookupCards)}
            </div>
          </div>
          {(entries.length > 1 || completionEligible || acknowledgeable || entry.options.length > 0 || answered) && <div className="pas-report-footer">
            {(completionEligible || acknowledgeable || entry.options.length > 0) && !(answered && sizing.overflowing && !completionEligible) && <div className="chat-ui-actions pas-report-actions" aria-hidden={suppressActions || undefined} inert={suppressActions || undefined} style={suppressActions ? { visibility: 'hidden' } : undefined}>
              {(completionEligible ? ['완료','보류'] : acknowledgeable ? ['확인했어'] : entry.options).map(option => <Button key={option} variant="outline" disabled={disabled || sending.sending || (completionEligible && completion.busy)} onClick={() => {
                if (completionEligible) {
                  const nextKey = entries[position + 1]?.key ?? entries[position - 1]?.key ?? null;
                  const target = option === '보류' ? 'on_hold' : 'done';
                  void completion.complete(cardEntry as ReportCardEntry & { card_id: string; card_numbers: number[] }, entries, target).then(done => {
                    if (done && nextKey && report.visibleKey === entry.key) selectKey(nextKey);
                  });
                } else if (acknowledgeable) {
                  if (entry.key.startsWith('card_') || entry.key.startsWith('cq_')) void dismissReport(entry.key);
                  else if (sending.close(entry)) void dismissReport(entry.key);
                } else void sending.reply(entry, option);
              }}>{option}</Button>)}
            </div>}
            {answered && <div className="pas-report-received">
              <p className="pas-report-todo"><span className="pas-report-received-label">받은 답</span>{answer}</p>
              {sending.canCancel(entry) && (sending.cancelRequested(entry) ? <span className="pas-report-cancel-sent">취소 요청 보냄</span> : <Button variant="ghost" size="xs" disabled={disabled || sending.sending} onClick={() => void sending.cancel(entry)}>취소 요청</Button>)}
            </div>}
          </div>}
          {position === index && completion.recent && <div className="pas-report-undo"><span className="pas-report-received-label">{completion.recent.label}</span><Button variant="ghost" size="xs" disabled={completion.busy} onClick={() => void completion.undo()}><UndoCountdownRing key={`${completion.recent.cardId}-${completion.recent.expiresAt}`} expiresAt={completion.recent.expiresAt} durationMs={CARD_COMPLETION_UNDO_MS}/>되돌리기</Button></div>}
        </article>;
      })}
    </div>
    {entries.length > 1 && <div className="pas-report-nav">
      <DashboardIconCap size="small" appearance="bare" label="앞 장" disabled={index === 0} onClick={() => go(index - 1)}><ChevronLeft className="size-5" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" /></DashboardIconCap>
      <span className="pas-report-count" aria-live="polite" aria-atomic="true">{index + 1} / {entries.length}</span>
      <DashboardIconCap size="small" appearance="bare" label="다음 장" disabled={index === entries.length - 1} onClick={() => go(index + 1)}><ChevronRight className="size-5" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" /></DashboardIconCap>
    </div>}
    {bubble && <i aria-hidden="true" className="pas-report-tail" data-direction={bubble.tailDirection} />}
  </section>;
  return bubble && seat?.target ? createPortal(deck, seat.target) : deck;
}

function ReportCardLink({ number, pending, lookupCards }: { number: number; pending: Set<number>; lookupCards: () => Promise<void> }) {
  const id = useCardStore(state => Object.values(state.byId).find(card => card.number === number)?.id);
  const anchor = useRef<HTMLAnchorElement>(null);
  const [openAfterLookup, setOpenAfterLookup] = useState(false);
  useEffect(() => {
    if (!openAfterLookup || !id) return;
    setOpenAfterLookup(false);
    // SourceLink has no imperative opener. Activate the resolved anchor after its
    // href commits so the existing internal-link handler/PAS card opener receives it.
    anchor.current?.click();
  }, [id, openAfterLookup]);
  const resolve = async (open: boolean, node: HTMLAnchorElement) => {
    if (open && pending.has(number)) return;
    if (open) { pending.add(number); anchor.current = node; }
    try {
      await lookupCards();
      if (open && Object.values(useCardStore.getState().byId).some(card => card.number === number)) setOpenAfterLookup(true);
    } finally { if (open) pending.delete(number); }
  };
  return <SourceLink href={id ? `/?card=${encodeURIComponent(id)}` : undefined}
    role="link" tabIndex={0} className={`v3-chat-status pas-report-card hover:underline ${LINK_FOCUS}`} aria-label={`카드 ${number}번 열기`}
    onKeyDown={event => { if (!id && event.key === 'Enter') {
      event.preventDefault();
      void resolve(!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey, event.currentTarget);
    } }}
    onAuxClick={event => { if (!id) { event.preventDefault(); void resolve(false, event.currentTarget); } }}
    onClick={event => {
      if (id) return;
      event.preventDefault();
      void resolve(event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey, event.currentTarget);
    }}><Link size={12} aria-hidden="true"/>#{number}</SourceLink>;
}

function ReportAction({ text }: { text: string }) {
  const matches = [...text.matchAll(/\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)/g)];
  let end = 0;
  const parts = matches.flatMap(match => {
    const prefix = text.slice(end, match.index);
    end = match.index! + match[0].length;
    return [prefix, <SourceLink key={match.index} href={match[2]} className={`text-info-foreground underline underline-offset-4 ${LINK_FOCUS}`}>{match[1]}</SourceLink>];
  });
  return <>{parts}{text.slice(end)}</>;
}
