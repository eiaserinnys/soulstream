import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button, DashboardIconCap, Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle,
  SwayCharacter, ThemeToggle,
} from "@seosoyoung/soul-ui";
import { House, ListTodo, RotateCcw } from "lucide-react";

import { DocumentReaderDialog } from "../DocumentReaderDialog";
import "../persistent-session-screen.css";
import { EvidenceArt } from "./EvidenceArt";
import { PasSplitChatPane } from "./PasSplitChatPane";
import { PasSplitClipboard } from "./PasSplitClipboard";
import { PasSplitComposer } from "./PasSplitComposer";
import { PasSplitHome } from "./PasSplitHome";
import { PasSplitTaskDrawer, type TaskDrawerGroup } from "./PasSplitTaskDrawer";
import {
  AGENDAS, AWAITING_CARDS, FOLDER_DOCUMENTS, HOLD_COUNT, INITIAL_CHAT, PROMOTED_DOCUMENT,
  QUEUED_CARDS, RUNNING_CARDS, type Agenda, type AgendaStatus, type ChatTurn, type FolderDocument,
} from "./pas-split-1707-data";
import "./v3-pas-split-1707.css";

type Route = "pas" | "pas-chat" | "home" | "folder-docs";
type MobileTab = "board" | "chat";

interface UndoRecord {
  agendaId: string | null;
  chatLength: number;
  documents: FolderDocument[];
  message: string;
}

interface InstructionTarget {
  agendaId: string;
  label: string;
}

const ROUTES: Route[] = ["pas", "pas-chat", "home", "folder-docs"];

function readRoute(): Route {
  if (typeof window === "undefined") return "pas";
  const hash = window.location.hash.replace(/^#/, "");
  return ROUTES.find(route => route === hash) ?? "pas";
}

function timeLabel(): string {
  return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
}

function objectParticle(text: string): string {
  const last = text.trim().at(-1);
  const code = last ? last.charCodeAt(0) : 0;
  const hasBatchim = code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0;
  return hasBatchim ? "을" : "를";
}

function useElementSize<T extends HTMLElement>(): [(node: T | null) => void, { width: number; height: number }] {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const observerRef = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: T | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node) return;
    const update = (width: number, height: number) => {
      if (width > 0 && height > 0) setSize(current => current.width === width && current.height === height ? current : { width, height });
    };
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      if (rect) update(rect.width, rect.height);
    });
    observer.observe(node);
    observerRef.current = observer;
    const rect = node.getBoundingClientRect();
    update(rect.width, rect.height);
  }, []);

  useEffect(() => () => observerRef.current?.disconnect(), []);
  return [ref, size];
}

export function PasSplitCommandMockup() {
  const [route, setRoute] = useState<Route>(readRoute);
  const [agendas, setAgendas] = useState<Agenda[]>(AGENDAS);
  const [activeId, setActiveId] = useState(AGENDAS[0].id);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [chat, setChat] = useState<ChatTurn[]>(INITIAL_CHAT);
  const [documents, setDocuments] = useState<FolderDocument[]>(FOLDER_DOCUMENTS);
  const [target, setTarget] = useState<InstructionTarget | null>(null);
  const [composer, setComposer] = useState("");
  const [undo, setUndo] = useState<UndoRecord | null>(null);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [evidenceAgendaId, setEvidenceAgendaId] = useState<string | null>(null);
  const [readerDocId, setReaderDocId] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<MobileTab>("board");
  const [characterRef, characterSize] = useElementSize<HTMLDivElement>();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const evidenceTriggerRef = useRef<HTMLButtonElement | null>(null);
  const taskToggleRef = useRef<HTMLButtonElement | null>(null);
  const docTriggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const chatSeq = useRef(0);

  useEffect(() => {
    const onChange = () => setRoute(readRoute());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const navigate = useCallback((next: Route) => {
    if (readRoute() !== next) window.location.hash = `#${next}`;
    setRoute(next);
  }, []);

  const pending = useMemo(() => agendas.filter(agenda => agenda.status === "pending"), [agendas]);
  const active = pending.find(agenda => agenda.id === activeId) ?? pending[0] ?? null;

  useEffect(() => {
    if (active && active.id !== activeId) setActiveId(active.id);
  }, [active, activeId]);

  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(() => setUndo(null), 15000);
    return () => window.clearTimeout(timer);
  }, [undo]);

  const nextTurnId = useCallback((prefix: string) => {
    chatSeq.current += 1;
    return `${prefix}-${chatSeq.current}`;
  }, []);

  const move = useCallback((delta: number) => {
    if (pending.length === 0) return;
    const index = Math.max(0, pending.findIndex(agenda => agenda.id === activeId));
    const next = pending[(index + delta + pending.length) % pending.length];
    if (next) setActiveId(next.id);
  }, [activeId, pending]);

  const boardVisible = route === "pas" && pending.length > 0;
  const quietMode = !boardVisible;

  useEffect(() => {
    if (!boardVisible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const element = document.activeElement;
      if (element instanceof HTMLElement
        && (element.tagName === "INPUT" || element.tagName === "TEXTAREA"
          || element.tagName === "SELECT" || element.isContentEditable)) return;
      if (evidenceAgendaId || readerDocId || tasksOpen) return;
      event.preventDefault();
      move(event.key === "ArrowRight" ? 1 : -1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [boardVisible, evidenceAgendaId, move, readerDocId, tasksOpen]);

  useEffect(() => {
    if (!tasksOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || evidenceAgendaId || readerDocId) return;
      event.stopPropagation();
      setTasksOpen(false);
      window.requestAnimationFrame(() => taskToggleRef.current?.focus());
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [evidenceAgendaId, readerDocId, tasksOpen]);

  const toggleCheck = (agendaId: string, checkId: string) => {
    const key = `${agendaId}:${checkId}`;
    setChecked(current => ({ ...current, [key]: !current[key] }));
  };

  const instruct = (agenda: Agenda, label: string) => {
    setTarget({ agendaId: agenda.id, label: `전달 대상: ${label}` });
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const clearTarget = () => {
    setTarget(null);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const dispose = (agenda: Agenda, status: AgendaStatus, message: string, document?: FolderDocument) => {
    const alreadyPromoted = document ? documents.some(item => item.id === document.id) : false;
    setUndo({ agendaId: agenda.id, chatLength: chat.length, documents, message });
    setAgendas(current => current.map(item => item.id === agenda.id ? { ...item, status } : item));
    if (document && !alreadyPromoted) setDocuments(current => [document, ...current]);
    setChat(current => [...current, { id: nextTurnId("chat"), role: "system", text: message, time: timeLabel() }]);
    const currentIndex = pending.findIndex(item => item.id === agenda.id);
    const remaining = pending.filter(item => item.id !== agenda.id);
    setActiveId(remaining[Math.min(Math.max(currentIndex, 0), remaining.length - 1)]?.id ?? null);
    setTarget(current => current?.agendaId === agenda.id ? null : current);
  };

  const runPrimary = (agenda: Agenda) => {
    if (!agenda.primary) return;
    if (agenda.primary.id === "approve") {
      dispose(agenda, "done", `#${agenda.number} 승인 완료로 처분했습니다.`);
    } else if (agenda.primary.id === "promote") {
      dispose(agenda, "done", `#${agenda.number} 폴더 문서로 남기고 완료했습니다.`, PROMOTED_DOCUMENT);
    } else if (agenda.primary.id === "verify3") {
      dispose(agenda, "awaiting", `#${agenda.number} 사흘 뒤 재확인으로 옮겼습니다.`);
    } else {
      dispose(agenda, "awaiting", `#${agenda.number} 저녁에 재확인으로 옮겼습니다.`);
    }
  };

  const send = () => {
    const text = composer.trim();
    if (!text) return;
    const currentTarget = target;
    const agenda = currentTarget ? agendas.find(item => item.id === currentTarget.agendaId) : null;
    const targetLabel = currentTarget?.label.replace(/^전달 대상: /, "");
    const userTurn: ChatTurn = {
      id: nextTurnId("chat"), role: "user", text, time: timeLabel(),
      target: targetLabel,
    };
    if (agenda && agenda.status === "pending" && currentTarget && targetLabel) {
      setUndo({ agendaId: agenda.id, chatLength: chat.length, documents, message: `${targetLabel}${objectParticle(targetLabel)} 보냈습니다.` });
      setAgendas(current => current.map(item => item.id === agenda.id ? { ...item, status: "running" } : item));
      setChat(current => [
        ...current,
        userTurn,
        {
          id: nextTurnId("chat"), role: "system",
          text: `${targetLabel}${objectParticle(targetLabel)} 보냈습니다. 진행 중으로 옮겼습니다.`,
          time: timeLabel(),
        },
      ]);
      const currentIndex = pending.findIndex(item => item.id === agenda.id);
      const remaining = pending.filter(item => item.id !== agenda.id);
      setActiveId(remaining[Math.min(Math.max(currentIndex, 0), remaining.length - 1)]?.id ?? null);
    } else {
      setChat(current => [...current, userTurn]);
    }
    setComposer("");
    setTarget(null);
  };

  const undoLast = () => {
    if (!undo) return;
    if (undo.agendaId) {
      setAgendas(current => current.map(item => item.id === undo.agendaId ? { ...item, status: "pending" } : item));
      setActiveId(undo.agendaId);
    }
    setDocuments(undo.documents);
    setChat(current => current.slice(0, undo.chatLength));
    setUndo(null);
  };

  const openEvidence = (agendaId: string) => setEvidenceAgendaId(agendaId);
  const closeEvidence = () => {
    setEvidenceAgendaId(null);
    window.requestAnimationFrame(() => evidenceTriggerRef.current?.focus());
  };
  const openDocument = (documentId: string) => setReaderDocId(documentId);
  const closeDocument = () => {
    const previousId = readerDocId;
    setReaderDocId(null);
    if (previousId) window.requestAnimationFrame(() => docTriggerRefs.current[previousId]?.focus());
  };

  const awaitingCards = useMemo(() => [
    ...AWAITING_CARDS,
    ...agendas.filter(agenda => agenda.status === "awaiting").map(agenda => ({
      id: `awaiting-${agenda.id}`, number: agenda.number, title: agenda.title, meta: "검증 대기, 방금",
    })),
  ], [agendas]);

  const runningCards = useMemo(() => [
    ...RUNNING_CARDS,
    ...agendas.filter(agenda => agenda.status === "running").map(agenda => ({
      id: `running-${agenda.id}`, number: agenda.number, title: agenda.title, meta: "진행 중, 방금",
    })),
  ], [agendas]);

  const taskGroups: TaskDrawerGroup[] = useMemo(() => [
    {
      id: "review", label: "검수", count: pending.length,
      cards: pending.map(agenda => ({
        id: agenda.id, number: agenda.number, title: agenda.title, meta: `검수 대기, ${agenda.kind}`,
      })),
    },
    { id: "awaiting", label: "검증 대기", count: awaitingCards.length, cards: awaitingCards },
    { id: "running", label: "진행 중", count: runningCards.length, cards: runningCards },
    { id: "queued", label: "대기열", count: QUEUED_CARDS.length, cards: QUEUED_CARDS },
    { id: "hold", label: "보류", count: HOLD_COUNT, cards: [] },
  ], [awaitingCards, pending, runningCards]);

  const isPas = route === "pas" || route === "pas-chat";
  const evidenceAgenda = agendas.find(agenda => agenda.id === evidenceAgendaId) ?? null;

  const closeTasks = () => {
    setTasksOpen(false);
    window.requestAnimationFrame(() => taskToggleRef.current?.focus());
  };

  return <div className="persistent-session-screen pas-split-app" data-testid="pas-split-app" data-route={route}>
    <header className="persistent-session-header pas-split-header">
      <div className="persistent-session-brand">
        <span>소울스트림</span>
        <strong>{isPas ? "서소영" : "오늘"}</strong>
      </div>
      <nav className="pas-split-nav" aria-label="주 화면">
        <button type="button" className="pas-split-nav-item" aria-current={isPas ? "page" : undefined}
          onClick={() => navigate("pas")}>PAS 지휘실</button>
        <button type="button" className="pas-split-nav-item" aria-current={!isPas ? "page" : undefined}
          onClick={() => navigate("home")}>홈</button>
      </nav>
      <div className="dashboard-toolbar-actions">
        <DashboardIconCap className="pas-split-home-cap" label="홈" appearance="bare" onClick={() => navigate("home")}>
          <House className="size-5" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true"/>
        </DashboardIconCap>
        {isPas ? <DashboardIconCap ref={taskToggleRef} label="작업 목록" appearance="bare" aria-expanded={tasksOpen}
          onClick={() => setTasksOpen(value => !value)}>
          <ListTodo className="size-5" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true"/>
        </DashboardIconCap> : null}
        <ThemeToggle variant="chrome" appearance="bare"/>
      </div>
    </header>

    {isPas ? <main className="pas-split-body" data-mode={quietMode ? "quiet" : "board"} data-mobile-tab={mobileTab}>
      <div className="pas-split-viewbar">
        <div className="pas-split-viewswitch" role="group" aria-label="PAS 보기">
          <button type="button" data-active={boardVisible || undefined} disabled={pending.length === 0}
            aria-pressed={boardVisible} onClick={() => navigate("pas")}>브리핑 서류판 ({pending.length})</button>
          <button type="button" data-active={quietMode || undefined} aria-pressed={quietMode}
            onClick={() => navigate("pas-chat")}>대화만 보기</button>
        </div>
        <div className="pas-split-mobile-tabs" role="tablist" aria-label="PAS 탭">
          <button type="button" role="tab" aria-selected={mobileTab === "board"} data-active={mobileTab === "board" || undefined}
            disabled={pending.length === 0} onClick={() => setMobileTab("board")}>브리핑 서류 ({pending.length})</button>
          <button type="button" role="tab" aria-selected={mobileTab === "chat"} data-active={mobileTab === "chat" || undefined}
            onClick={() => setMobileTab("chat")}>PAS 대화</button>
        </div>
      </div>

      {quietMode ? <div ref={characterRef} className="pas-quiet-character" aria-hidden="true">
        {characterSize.width > 0 && characterSize.height > 0 ? <SwayCharacter
          shown width={Math.min(characterSize.width, Math.round(characterSize.height * 2 / 3))}
          height={characterSize.height}
          motionEnabled active={!document.hidden} assetBaseUrl="/characters/seosoyoung"/> : null}
      </div> : null}

      {boardVisible && pending.length > 0 ? <section className="pas-split-clipboard" aria-label="브리핑 서류판">
        <PasSplitClipboard
          agenda={active}
          pending={pending}
          checked={checked}
          onSelect={setActiveId}
          onMove={move}
          onToggleCheck={toggleCheck}
          onInstruct={instruct}
          onEvidence={openEvidence}
          onPrimary={runPrimary}
          evidenceTriggerRef={evidenceTriggerRef}
        />
      </section> : null}

      <section className="pas-split-chat" aria-label="실시간 PAS 대화">
        <PasSplitChatPane turns={chat}/>
      </section>

      <div className="pas-split-composer-seat">
        <PasSplitComposer target={target} value={composer} inputRef={textareaRef}
          onChange={setComposer} onSend={send} onClearTarget={clearTarget}/>
      </div>

      {tasksOpen ? <PasSplitTaskDrawer groups={taskGroups} onClose={closeTasks}/> : null}
    </main> : <PasSplitHome
      route={route}
      documents={documents}
      pendingCount={pending.length}
      runningCount={runningCards.length}
      awaitingCount={awaitingCards.length}
      queuedCount={QUEUED_CARDS.length}
      holdCount={HOLD_COUNT}
      onNavigate={navigate}
      onOpenDocument={openDocument}
      docTriggerRefs={docTriggerRefs}
    />}

    {undo ? <div className="pas-split-toast glass-strong glass-chrome lg-rim" role="status" data-testid="pas-split-toast">
      <span>{undo.message}</span>
      <Button variant="ghost" size="sm" onClick={undoLast}>
        <RotateCcw className="size-4" aria-hidden="true"/>되돌리기
      </Button>
    </div> : null}

    <Dialog open={evidenceAgenda !== null} onOpenChange={open => { if (!open) closeEvidence(); }}>
      <DialogPopup className="v3-surface pas-split-evidence-dialog max-w-2xl">
        <DialogHeader><DialogTitle>{evidenceAgenda?.evidence.label ?? "시각 증거"}</DialogTitle></DialogHeader>
        <DialogPanel>
          {evidenceAgenda ? <>
            <div className="pas-evidence-art pas-evidence-art--large"><EvidenceArt kind={evidenceAgenda.evidence.kind}/></div>
            <p className="pas-evidence-copy">{evidenceAgenda.evidence.caption}</p>
            <p className="pas-evidence-meta">#{evidenceAgenda.number} {evidenceAgenda.title}</p>
          </> : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>

    <DocumentReaderDialog documentId={readerDocId} onClose={closeDocument}/>
  </div>;
}
