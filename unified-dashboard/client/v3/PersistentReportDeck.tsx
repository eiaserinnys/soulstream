import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, DashboardIconCap, type PersistentReportEntry } from '@seosoyoung/soul-ui';
import { SourceLink } from '@seosoyoung/soul-ui/components/SourceLink';
import { usePersistentReport } from '@seosoyoung/soul-ui/components/persistent-report/PersistentReportProvider';
import { createPortal } from 'react-dom';
import type { PersistentSessionReportBubbleLayout, PersistentSessionRect } from '@seosoyoung/soul-ui/lib/persistent-session-layout';
import { submitIntervention } from '@seosoyoung/soul-ui/components/chat/submitIntervention';
import { usePersistentReportSend } from './usePersistentReportSend';
import { useReportDeckHeight } from './useReportDeckHeight';
import { ChevronLeft, ChevronRight, Link } from 'lucide-react';
import { useCardStore } from '@seosoyoung/soul-ui/cards/card-store';
import { cardRequest } from '@seosoyoung/soul-ui/cards/card-api';
import type { CardRow } from '@seosoyoung/soul-ui/cards/card-types';
import '@seosoyoung/soul-ui/components/chat-ui/chat-ui.css';
import './persistent-report.css';

export type ReportBubbleSeat = { target: HTMLElement | null; layout: PersistentSessionReportBubbleLayout | null; body: PersistentSessionRect | null };
type Props = { sessionId: string; focusInput: () => void; dismissReport: (key: string) => Promise<void>; notify: (text: string) => void; disabled?: boolean; seat?: ReportBubbleSeat; transport?: typeof submitIntervention };
const LINK_FOCUS = 'rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background';

export function PersistentReportDeck({ sessionId, focusInput, dismissReport, notify, disabled = false, seat, transport }: Props) {
  const report = usePersistentReport()!;
  const { entries, visibleKey } = report;
  const sending = usePersistentReportSend(sessionId, notify, transport);
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
  const index = Math.max(0, entries.findIndex(entry => entry.key === visibleKey));
  const track = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement | null>(null);
  const sizing = useReportDeckHeight(root, [entries, sending, seat], sessionId);
  const bubble = seat?.target && seat.body ? seat.layout : null;
  const focusWithin = useRef(false);
  const flying = useRef<number | null>(null);
  const current = useRef({ index });
  current.current = { index };

  const go = (target: number) => {
    const node = track.current;
    const at = Math.max(0, Math.min(entries.length - 1, target));
    if (!node || at === index) return;
    if ((at === 0 || at === entries.length - 1) && document.activeElement?.closest('.pas-report-nav')) node.focus({ preventScroll: true });
    flying.current = at;
    report.view(entries[at].key);
    node.scrollTo({ left: at * node.clientWidth, behavior: 'smooth' });
  };
  useLayoutEffect(() => {
    const node = track.current;
    if (!node) return;
    const align = () => { if (sizing.holding.current) return; flying.current = null; node.scrollTo({ left: current.current.index * node.clientWidth, behavior: 'auto' }); };
    align();
    const observer = new ResizeObserver(align);
    observer.observe(node);
    return () => observer.disconnect();
  }, [entries, sessionId]);
  useLayoutEffect(() => {
    if (!focusWithin.current || !root.current) return;
    // A removed section still contains its old children in the retained ref.
    // An empty board must focus the composer instead of querying that detached subtree.
    if (!entries.length) { focusWithin.current = false; focusInput(); return; }
    const active = document.activeElement;
    const sheet = root.current.querySelector<HTMLElement>('[data-current="true"]');
    if (sheet?.contains(active) || (root.current.contains(active) && !active?.closest('.pas-report-sheet'))) return;
    if (sheet) sheet.focus({ preventScroll: true });
  }, [visibleKey, entries.length, focusInput]);

  if (!entries.length) return null;
  const deck = <section ref={node => { if (node) root.current = node; }} className="pas-report" data-bubble={Boolean(bubble)} style={{ height: sizing.height, maxHeight: bubble?.maxHeight, ...(bubble && seat?.body ? { position: 'absolute', left: bubble.left - seat.body.left, top: bubble.bottom - seat.body.top, width: bubble.width, transform: 'translateY(-100%)', '--pas-report-tail-left': `${bubble.tailLeft}px` } : {}) } as React.CSSProperties} data-testid="report-deck" data-many={entries.length > 1}
    aria-label="지금의 보고" aria-roledescription="carousel"
    onPointerDownCapture={sizing.hold} onPointerUpCapture={sizing.release} onPointerCancel={sizing.release}
    onFocusCapture={() => { focusWithin.current = true; }}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null) && (event.relatedTarget || event.target.isConnected)) focusWithin.current = false; }}
    onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); go(index + (event.key === 'ArrowRight' ? 1 : -1)); } }}>
    <div ref={track} className="pas-report-track" data-testid="report-track" tabIndex={entries.length > 1 ? 0 : -1} role="group" aria-label="보고 장. 좌우 화살표로 넘깁니다"
      onScroll={event => {
        const node = event.currentTarget;
        const at = Math.round(node.scrollLeft / Math.max(1, node.clientWidth));
        if (flying.current !== null) { if (at !== flying.current) return; flying.current = null; }
        if (entries[at]) report.view(entries[at].key);
      }}
      onScrollEnd={event => {
        flying.current = null; sizing.release();
        const at = Math.round(event.currentTarget.scrollLeft / Math.max(1, event.currentTarget.clientWidth));
        if (entries[at]) report.view(entries[at].key);
      }}>
      {entries.map((entry, position) => {
        const answer = report.answer(entry);
        const answered = answer !== undefined;
        const tag = entry.kind === 'see' ? '보실 것' : answered ? '답 받음' : '답하실 것';
        return <article key={entry.key} className="pas-report-sheet" data-testid={`report-sheet-${entry.key}`} data-current={position === index}
          data-publication={JSON.stringify([sessionId, entry.key, entry.title, entry.context, entry.action, entry.options])} inert={position !== index} aria-hidden={position !== index} tabIndex={-1} aria-roledescription="slide"
          aria-label={`${entries.length > 1 ? `${position + 1} / ${entries.length}, ` : ''}${tag}, ${entry.title}`}>
          <div className="pas-report-reading v3-session-panel-scroll" onScroll={event => {
            const node = event.currentTarget;
            node.dataset.more = String(node.scrollHeight - node.scrollTop - node.clientHeight > 1);
          }} ref={node => { if (node) node.dataset.more = String(node.scrollHeight - node.scrollTop - node.clientHeight > 1); }}>
            <div className="pas-report-content">
              <div className="pas-report-heading">
                <h2 className="pas-report-title">{entry.title}</h2>
                {entry.card_numbers.map(number => <ReportCardLink key={number} number={number} pending={pendingCardNumbers} lookupCards={lookupCards} />)}
              </div>
              <p className="pas-report-context">{entry.context}</p>
              {!answered && <p className="pas-report-todo"><ReportAction text={entry.action} /></p>}
            </div>
          </div>
          {(entries.length > 1 || entry.kind === 'see' || entry.options.length > 0 || answered) && <div className="pas-report-footer">
            {(entry.kind === 'see' || entry.options.length > 0) && <div className="chat-ui-actions pas-report-actions" aria-hidden={answered || undefined} inert={answered || undefined} style={answered ? { visibility: 'hidden' } : undefined}>
              {(entry.kind === 'see' ? ['봤다'] : entry.options).map(option => <Button key={option} variant="outline" disabled={entry.kind === 'ask' && (disabled || sending.sending)} onClick={() => {
                if (entry.kind === 'see') void dismissReport(entry.key);
                else void sending.reply(entry, option);
              }}>{option}</Button>)}
            </div>}
            {answered && <div className="pas-report-received">
              <p className="pas-report-todo"><span className="pas-report-received-label">받은 답</span>{answer}</p>
              {sending.canCancel(entry) && (sending.cancelRequested(entry) ? <span className="pas-report-cancel-sent">취소 요청 보냄</span> : <Button variant="ghost" size="xs" disabled={disabled || sending.sending} onClick={() => void sending.cancel(entry)}>취소 요청</Button>)}
            </div>}
          </div>}
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
    role="link" tabIndex={0} className={`v3-chat-status pas-report-card text-info-foreground hover:underline ${LINK_FOCUS}`} aria-label={`카드 ${number}번 열기`}
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
