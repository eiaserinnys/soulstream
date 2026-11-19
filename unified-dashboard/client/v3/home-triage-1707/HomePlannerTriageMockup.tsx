// 시안 C: 홈 플래너 3단 트리아지 장부와 지켜보는 중 선반.
// 홈(폴더, 확인할 것 장부, 담당 세션)과 PAS 화면을 한 도구 막대로 오간다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGlassSurface } from "@seosoyoung/soul-ui";

import "./v3-home-triage-1707.css";
import { AssigneeSessionPanel } from "./AssigneeSessionPanel";
import { KanbanBoard, PostItBoardGrid } from "./BoardViews";
import { FolderNav } from "./FolderNav";
import { PasScreen } from "./PasScreen";
import { TriageLedger } from "./TriageLedger";
import { TriageToolbar } from "./TriageToolbar";
import {
  backgroundBoardCards,
  mockupFolders,
  triageCardToBoardCard,
  triageCards,
  watchCards,
  type SessionMessage,
  type TriageCard,
} from "./triage-data";

type View = "home" | "pas";
type HomeTab = "triage" | "grid" | "board";
type MobileTab = "triage" | "folders" | "session";
type CardState = "pending" | "watched" | "done";

const HOME_TABS: readonly { id: HomeTab; label: string }[] = [
  { id: "triage", label: "트리아지 장부" },
  { id: "grid", label: "포스트잇 격자" },
  { id: "board", label: "칸반 보드" },
];

const MOBILE_TABS: readonly { id: MobileTab; icon: string; label: string }[] = [
  { id: "triage", icon: "▦", label: "오늘 트리아지" },
  { id: "folders", icon: "📁", label: "폴더" },
  { id: "session", icon: "💬", label: "담당 세션" },
];

const ALL_CARDS: readonly TriageCard[] = [...triageCards, ...watchCards];

const INITIAL_STATES: Record<string, CardState> = Object.fromEntries([
  ...triageCards.map(card => [card.id, "pending"] as const),
  ...watchCards.map(card => [card.id, "watched"] as const),
]);

function MobileTabs({ active, onSelect }: { active: MobileTab; onSelect(tab: MobileTab): void }) {
  const ref = useRef<HTMLElement>(null);
  const glass = useGlassSurface(ref, { enabled: true });
  return (
    <nav
      ref={ref}
      className="v3-mobile-tabs border border-glass-border glass-strong glass-chrome"
      data-liquid-glass-webgl={glass ? "true" : undefined}
      aria-label="모바일 화면 탭"
      role="tablist"
    >
      {MOBILE_TABS.map(tab => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          className={`v3-mobile-tab${active === tab.id ? " is-active" : ""}`}
          onClick={() => onSelect(tab.id)}
          data-testid={`v3-ht-mobile-tab-${tab.id}`}
        >
          <span className="v3-mobile-tab-icon" aria-hidden="true">{tab.icon}</span>
          <span>{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}

export function HomePlannerTriageMockup() {
  const [view, setView] = useState<View>("home");
  const [tab, setTab] = useState<HomeTab>("triage");
  const [mobileTab, setMobileTab] = useState<MobileTab>("triage");
  const [folder, setFolder] = useState<string | null>(null);
  const [cardStates, setCardStates] = useState<Record<string, CardState>>(INITIAL_STATES);
  const [selectedId, setSelectedId] = useState<string | null>(triageCards[0]?.id ?? null);
  const [shelfOpen, setShelfOpen] = useState(false);
  const [undoCard, setUndoCard] = useState<TriageCard | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [extraMessages, setExtraMessages] = useState<Record<string, SessionMessage[]>>({});
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const pendingAll = useMemo(() => ALL_CARDS.filter(card => cardStates[card.id] === "pending"), [cardStates]);
  const watched = useMemo(() => ALL_CARDS.filter(card => cardStates[card.id] === "watched"), [cardStates]);
  const visiblePending = useMemo(
    () => (folder ? pendingAll.filter(card => card.folderId === folder) : pendingAll),
    [pendingAll, folder],
  );
  const selected = visiblePending.find(card => card.id === selectedId) ?? null;

  const boardCards = useMemo(() => {
    const fromCards = ALL_CARDS
      .filter(card => cardStates[card.id] !== "watched")
      .map(card => {
        const base = triageCardToBoardCard(card);
        return cardStates[card.id] === "done"
          ? { ...base, status: "done" as const, activity: "완료 보고를 남겼습니다." }
          : base;
      });
    return [...backgroundBoardCards, ...fromCards];
  }, [cardStates]);
  const visibleBoard = useMemo(
    () => (folder ? boardCards.filter(card => card.folderId === folder) : boardCards),
    [boardCards, folder],
  );

  const reviewCount = pendingAll.filter(card => card.kind === "검수 대기").length;
  const folderName = folder ? mockupFolders.find(entry => entry.id === folder)?.name ?? null : null;

  useEffect(() => {
    const applyHash = () => {
      const hash = window.location.hash.replace(/^#/, "");
      if (hash === "pas") {
        setView("pas");
        return;
      }
      setView("home");
      if (hash === "triage" || hash === "grid" || hash === "board") setTab(hash);
    };
    applyHash();
    if (!window.location.hash) window.history.replaceState(null, "", "#triage");
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, []);

  const navigate = useCallback((next: HomeTab | "pas") => {
    if (next === "pas") setView("pas");
    else {
      setView("home");
      setTab(next);
    }
    if (window.location.hash === `#${next}`) window.history.replaceState(null, "", `#${next}`);
    else window.location.hash = next;
  }, []);

  const move = useCallback((delta: number) => {
    if (visiblePending.length === 0) return;
    const index = visiblePending.findIndex(card => card.id === selectedId);
    const next = visiblePending[(index + delta + visiblePending.length) % visiblePending.length];
    if (next) setSelectedId(next.id);
  }, [visiblePending, selectedId]);

  useEffect(() => {
    if (visiblePending.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!visiblePending.some(card => card.id === selectedId)) setSelectedId(visiblePending[0]!.id);
  }, [visiblePending, selectedId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (view !== "home" || tab !== "triage") return;
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (document.querySelector("dialog[open]")) return;
      if (event.key === "ArrowDown" || event.key === "j") {
        event.preventDefault();
        move(1);
      } else if (event.key === "ArrowUp" || event.key === "k") {
        event.preventDefault();
        move(-1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [view, tab, move]);

  const focusComposer = () => {
    setMobileTab("session");
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  const shelve = (card: TriageCard) => {
    const index = visiblePending.findIndex(item => item.id === card.id);
    setCardStates(prev => ({ ...prev, [card.id]: "watched" }));
    setUndoCard(card);
    const rest = visiblePending.filter(item => item.id !== card.id);
    const next = rest[Math.min(Math.max(index, 0), rest.length - 1)];
    setSelectedId(next?.id ?? null);
  };

  const undo = () => {
    if (!undoCard) return;
    setCardStates(prev => ({ ...prev, [undoCard.id]: "pending" }));
    setSelectedId(undoCard.id);
    setUndoCard(null);
  };

  const complete = (card: TriageCard) => {
    setCardStates(prev => ({ ...prev, [card.id]: "done" }));
    setUndoCard(null);
    const rest = visiblePending.filter(item => item.id !== card.id);
    setSelectedId(rest[0]?.id ?? null);
  };

  const completeAllWatched = () => {
    setCardStates(prev => {
      const next = { ...prev };
      for (const card of watched) next[card.id] = "done";
      return next;
    });
    setShelfOpen(false);
    setUndoCard(null);
  };

  const primary = (card: TriageCard) => {
    if (card.kind === "질문") {
      setDrafts(prev => ({
        ...prev,
        [card.id]: prev[card.id]?.trim() ? prev[card.id]! : `#${card.number} 관련: `,
      }));
      focusComposer();
      return;
    }
    complete(card);
  };

  const openCard = (id: string) => {
    const card = ALL_CARDS.find(item => item.id === id);
    if (!card || cardStates[card.id] !== "pending") return;
    setSelectedId(id);
    navigate("triage");
    setMobileTab("triage");
  };

  const draft = selected ? drafts[selected.id] ?? "" : "";
  const messages = selected ? [...selected.session.messages, ...(extraMessages[selected.id] ?? [])] : [];

  const send = () => {
    if (!selected) return;
    const text = (drafts[selected.id] ?? "").trim();
    if (!text) return;
    setExtraMessages(prev => ({
      ...prev,
      [selected.id]: [...(prev[selected.id] ?? []), {
        id: `${selected.id}-sent-${(prev[selected.id]?.length ?? 0) + 1}`,
        role: "user",
        text,
        time: "지금",
      }],
    }));
    setDrafts(prev => ({ ...prev, [selected.id]: "" }));
  };

  const emptyState = <div className="v3-ht-empty"><p>이 폴더에 보여 줄 카드가 없습니다.</p><p>다른 폴더를 고르세요.</p></div>;

  return (
    <div
      className="v3-home-triage-1707"
      data-view={view}
      data-home-tab={tab}
      data-mobile-tab={mobileTab}
      data-testid="v3-ht-root"
    >
      <TriageToolbar view={view} onOpenPas={() => navigate("pas")} />
      {view === "home" ? (
        <div className="v3-ht-panes">
          <div className={`v3-ht-slot${mobileTab === "folders" ? " is-mobile-active" : ""}`} data-slot-name="folders">
            <FolderNav folder={folder} onSelect={setFolder} />
          </div>
          <div className={`v3-ht-slot v3-ht-slot--center${mobileTab === "triage" ? " is-mobile-active" : ""}`} data-slot-name="planner">
            <main className="v3-ht-pane v3-ht-planner glass-strong glass-chrome lg-rim border border-glass-border">
              <header className="v3-ht-planner-head">
                <div className="v3-ht-title-block">
                  <p className="v3-ht-eyebrow">홈</p>
                  <h1>전체 카드</h1>
                  {folderName ? (
                    <button type="button" className="v3-ht-filter-chip" onClick={() => setFolder(null)}>
                      {folderName} 필터 해제
                    </button>
                  ) : null}
                </div>
                <div className="v3-ht-switch" role="tablist" aria-label="카드 보기 방식">
                  {HOME_TABS.map(item => (
                    <button
                      key={item.id}
                      type="button"
                      role="tab"
                      aria-selected={tab === item.id}
                      className="v3-ht-switch-button"
                      onClick={() => navigate(item.id)}
                      data-testid={`v3-ht-tab-${item.id}`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </header>
              <div className="v3-ht-planner-scroll">
                {tab === "triage" ? (
                  <TriageLedger
                    pending={visiblePending}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    onNext={() => move(1)}
                    onShelve={shelve}
                    onPrimary={primary}
                    onOpenSession={focusComposer}
                    watched={watched}
                    shelfOpen={shelfOpen}
                    onToggleShelf={() => setShelfOpen(open => !open)}
                    onReopen={card => {
                      setCardStates(prev => ({ ...prev, [card.id]: "pending" }));
                      setSelectedId(card.id);
                      setUndoCard(null);
                    }}
                    onComplete={complete}
                    onCompleteAll={completeAllWatched}
                    undo={undoCard}
                    onUndo={undo}
                  />
                ) : null}
                {tab === "grid" ? (
                  visiblePending.length === 0 ? emptyState
                    : <PostItBoardGrid cards={visiblePending} onOpen={openCard} />
                ) : null}
                {tab === "board" ? (
                  visibleBoard.length === 0 ? emptyState
                    : <KanbanBoard cards={visibleBoard} onOpen={openCard} />
                ) : null}
              </div>
            </main>
          </div>
          <div className={`v3-ht-slot${mobileTab === "session" ? " is-mobile-active" : ""}`} data-slot-name="session">
            <AssigneeSessionPanel
              card={selected}
              messages={messages}
              draft={draft}
              onDraft={value => {
                if (!selected) return;
                setDrafts(prev => ({ ...prev, [selected.id]: value }));
              }}
              onSend={send}
              composerRef={composerRef}
              onOpenCard={() => {
                if (!selected) return;
                navigate("triage");
                setMobileTab("triage");
              }}
            />
          </div>
        </div>
      ) : (
        <PasScreen reviewCount={reviewCount} onGoHome={() => navigate("triage")} />
      )}
      {view === "home" ? <MobileTabs active={mobileTab} onSelect={setMobileTab} /> : null}
    </div>
  );
}
