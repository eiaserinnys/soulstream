import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, DashboardIconCap, type PersistentReportEntry } from '@seosoyoung/soul-ui';
import { SourceLink } from '@seosoyoung/soul-ui/components/SourceLink';
import { usePersistentReport } from '@seosoyoung/soul-ui/components/persistent-report/PersistentReportProvider';
import type { ChatUiComposerHandle } from '@seosoyoung/soul-ui/components/chat-ui/chat-ui-composer';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCardStore } from '@seosoyoung/soul-ui/cards/card-store';
import { cardRequest } from '@seosoyoung/soul-ui/cards/card-api';
import type { CardRow } from '@seosoyoung/soul-ui/cards/card-types';
import '@seosoyoung/soul-ui/components/chat-ui/chat-ui.css';
import './persistent-report.css';

type Props = { sessionId: string; appendGeneratedText: ChatUiComposerHandle['appendGeneratedText']; focusInput: () => void; dismissReport: (key: string) => Promise<void> };
const LINK_FOCUS = 'rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background';

export function PersistentReportDeck({ sessionId, appendGeneratedText, focusInput, dismissReport }: Props) {
  const report = usePersistentReport()!;
  const { entries, visibleKey } = report;
  const pendingCardNumbers = useRef(new Set<number>()).current;
  const index = Math.max(0, entries.findIndex(entry => entry.key === visibleKey));
  const track = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement | null>(null);
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
    const align = () => { flying.current = null; node.scrollTo({ left: current.current.index * node.clientWidth, behavior: 'auto' }); };
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
  return <section ref={node => { if (node) root.current = node; }} className="pas-report" data-testid="report-deck" data-many={entries.length > 1}
    aria-label="지금의 보고" aria-roledescription="carousel"
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
        flying.current = null;
        const at = Math.round(event.currentTarget.scrollLeft / Math.max(1, event.currentTarget.clientWidth));
        if (entries[at]) report.view(entries[at].key);
      }}>
      {entries.map((entry, position) => {
        const answer = report.answer(entry);
        const answered = answer !== undefined;
        const tag = entry.kind === 'see' ? '보실 것' : answered ? '답 받음' : '답하실 것';
        return <article key={entry.key} className="pas-report-sheet" data-testid={`report-sheet-${entry.key}`} data-current={position === index}
          inert={position !== index} aria-hidden={position !== index} tabIndex={-1} aria-roledescription="slide"
          aria-label={`${entries.length > 1 ? `${position + 1} / ${entries.length}, ` : ''}${tag}, ${entry.title}`}>
          <div className="pas-report-reading">
            <div className="pas-report-heading">
              <div className="pas-report-tags">
                <span className="pas-report-kind" data-kind={entry.kind === 'ask' && !answered ? 'ask' : 'see'}>{tag}</span>
                {entry.card_numbers.map(number => <ReportCardLink key={number} number={number} pending={pendingCardNumbers} />)}
              </div>
              <h2 className="pas-report-title">{entry.title}</h2>
            </div>
            <p className="pas-report-context">{entry.context}</p>
            {/* Retain the source's intrinsic height, not a stretched tallest-page measurement. */}
            <p className="pas-report-todo" aria-hidden={answered || undefined} inert={answered || undefined} style={answered ? { visibility: 'hidden' } : undefined}><ReportAction text={entry.action} /></p>
          </div>
          {(entry.kind === 'see' || entry.options.length > 0) && <div className="chat-ui-actions pas-report-actions" aria-hidden={answered || undefined} inert={answered || undefined} style={answered ? { visibility: 'hidden' } : undefined}>
            {(entry.kind === 'see' ? ['봤다'] : entry.options).map(option => <Button key={option} variant="outline" onClick={() => {
              if (entry.kind === 'see') {
                void dismissReport(entry.key);
              } else {
                const result = appendGeneratedText(sessionId, `${entry.title}: ${option}`);
                if (result.ok) report.bindReply(entry, option);
              }
            }}>{option}</Button>)}
          </div>}
          {answered && <p className="pas-report-todo pas-report-received"><span className="pas-report-received-label">받은 답</span>{answer}</p>}
        </article>;
      })}
    </div>
    {entries.length > 1 && <div className="pas-report-nav">
      <DashboardIconCap size="small" appearance="bare" label="앞 장" disabled={index === 0} onClick={() => go(index - 1)}><ChevronLeft className="size-5" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" /></DashboardIconCap>
      <span className="pas-report-count" aria-live="polite" aria-atomic="true">{index + 1} / {entries.length}</span>
      <DashboardIconCap size="small" appearance="bare" label="다음 장" disabled={index === entries.length - 1} onClick={() => go(index + 1)}><ChevronRight className="size-5" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" /></DashboardIconCap>
    </div>}
  </section>;
}

function ReportCardLink({ number, pending }: { number: number; pending: Set<number> }) {
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
  return <SourceLink href={id ? `/?card=${encodeURIComponent(id)}` : undefined}
    role="link" tabIndex={0} className={`pas-report-card text-info-foreground hover:underline ${LINK_FOCUS}`} aria-label={`카드 ${number}번 열기`}
    onKeyDown={event => { if (!id && event.key === 'Enter') { event.preventDefault(); event.currentTarget.click(); } }}
    onClick={event => {
      if (id) return;
      event.preventDefault();
      if (pending.has(number)) return;
      anchor.current = event.currentTarget;
      pending.add(number);
      void (async () => {
        try {
          const { cards } = await cardRequest<{ cards: CardRow[] }>('/api/cards?includeCompleted=true');
          const store = useCardStore.getState();
          store.putCards(cards.filter(card => !store.byId[card.id] || store.byId[card.id].version <= card.version));
          if (Object.values(useCardStore.getState().byId).some(card => card.number === number)) setOpenAfterLookup(true);
        } catch { /* Match the existing card-number link's silent failure policy. */ }
        finally { pending.delete(number); }
      })();
    }}>#{number}</SourceLink>;
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
