// 카드 #1707 시안 A. 정본 PAS 화면 위에 결재 보고 말풍선 하나만 얹고,
// 말풍선에서 연 한 장짜리 결재 브리핑 갑지에서 다섯 안건을 처분한다.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  Badge, Button, ChatView, DashboardIconCap, PersistentSessionPortraitIcon, PersistentSessionPortraitOffIcon,
  SwayCharacter, useDashboardStore, useIsMobile,
} from "@seosoyoung/soul-ui";
import type { SoulSSEEvent } from "@seosoyoung/soul-ui/shared/types";
import type { CardStatus } from "@seosoyoung/soul-ui/cards/card-types";
import { ListTodo, Maximize2, X } from "lucide-react";
import { DocumentReaderDialog } from "../DocumentReaderDialog";
import { PersistentSessionTaskList } from "../PersistentSessionTaskList";
import { StatusChip } from "../StatusChip";
import { V3GlobalToolbar } from "../V3GlobalToolbar";
import { usePersistentSessionGeometry } from "../use-persistent-session-geometry";
import { PasReviewReportDialog, type DispositionRecord, type ReportNotice } from "./PasReviewReportDialog";
import {
  AGENDAS, HOLD_COUNT, PAS_SESSION_ID, SEED_EVENTS,
  baseTaskStatus, taskCard, type Agenda, type AgendaStamp, type StampOutcome,
} from "./data";
import "../persistent-session-screen.css";
import "../persistent-report.css";
import "./v3-pas-report-briefing-1707.css";

const UNDO_MS = 15_000;
const ACTION_GUARD_MS = 400;
const START_EVENT_ID = 1000;

type UndoState = {
  agendaKey: string;
  actionId: string;
  nodeIds: string[];
};

const STAMP_MESSAGES: Record<string, string> = {
  "1680:ask": "고른 이유를 되물었습니다.",
  "1512:did": "했어로 알렸습니다.",
  "1512:evening": "저녁에 다시 보기로 했습니다.",
  "1387:reference": "참고 문서로 남기고 완료했습니다.",
  "1387:plain": "일반 완료했습니다.",
  "1408:approve": "승인 완료했습니다.",
  "1112:recheck": "사흘 뒤 재확인으로 두었습니다.",
  "1112:now": "지금 완료했습니다.",
};

function routeView(): "pas" | "report" {
  const own = window.location.hash.replace(/^#/, "");
  if (own === "report" || own === "pas") return own;
  try {
    const parent = window.parent.location;
    const parentHash = parent.hash.replace(/^#/, "");
    if (parentHash === "report") return "report";
    if (new URLSearchParams(parent.search).get("view") === "report") return "report";
  } catch { /* 다른 출처의 부모 창은 읽지 않는다. */ }
  if (new URLSearchParams(window.location.search).get("view") === "report") return "report";
  return "pas";
}

function writeView(view: "pas" | "report") {
  try { window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${view}`); }
  catch { window.location.hash = view; }
}

function chatNodeIds(): string[] {
  const tree = useDashboardStore.getState().tree;
  return tree ? tree.children.map(child => child.id) : [];
}

export function PasReportBriefingMockup() {
  const appRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const composerAnchorRef = useRef<HTMLDivElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const completionButtonRef = useRef<HTMLButtonElement>(null);
  const [reportTarget, setReportTarget] = useState<HTMLDivElement | null>(null);
  const isMobile = useIsMobile();
  const [characterShown, setCharacterShown] = useState(true);
  const [chatReady, setChatReady] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(() => routeView() === "report");
  const [index, setIndex] = useState(0);
  const [dispositions, setDispositions] = useState<Record<string, DispositionRecord>>({});
  const [notice, setNotice] = useState<ReportNotice | null>(null);
  const [undo, setUndo] = useState<UndoState | null>(null);
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [docId, setDocId] = useState<string | null>(null);
  const dispositionsRef = useRef(dispositions);
  const undoRef = useRef<UndoState | null>(null);
  const undoTimer = useRef<number | null>(null);
  const nextEventId = useRef(START_EVENT_ID);
  const addedNodes = useRef(new Set<string>());
  const lastActionAt = useRef(0);

  useLayoutEffect(() => {
    const store = useDashboardStore.getState();
    store.setActiveSession(PAS_SESSION_ID);
    store.setActiveSessionSummary({
      agentSessionId: PAS_SESSION_ID, status: "completed", sessionType: "claude", backend: "claude",
      eventCount: SEED_EVENTS.length, nodeId: "eiaserinnys",
      createdAt: "2026-11-19T09:00:00Z", updatedAt: "2026-11-19T09:00:00Z",
    });
    store.setPersistentSessionDisplaySettings(PAS_SESSION_ID, {
      show_generation_separator: false, show_jev_candidates: false, show_character: true,
      animate_character: true, turn_usage_mode: "collapsed", show_work_details: false,
    });
    store.processEvents(SEED_EVENTS.map((event, offset) => ({
      event: (event.type === "user_message"
        ? { type: "user_message", user: event.user ?? "User", text: event.text ?? "" }
        : { type: "assistant_message", content: event.content ?? "" }) as SoulSSEEvent,
      eventId: offset + 1,
    })));
  }, []);

  useEffect(() => { setChatReady(true); }, []);

  useEffect(() => {
    const sync = () => setReportOpen(routeView() === "report");
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  useEffect(() => () => {
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
  }, []);

  const geometry = usePersistentSessionGeometry({
    app: appRef, header: headerRef, main: mainRef, composer: composerAnchorRef,
    enabled: chatReady, showCharacter: characterShown,
  });

  const active = useMemo(() => AGENDAS.filter(agenda => !dispositions[agenda.key]), [dispositions]);
  const bubbleAgenda = active[0] ?? null;
  const activeCount = active.length;
  const bubbleCount = bubbleAgenda ? `${active.indexOf(bubbleAgenda) + 1} / ${activeCount}` : "";

  const cards = useMemo(() => AGENDAS.map(agenda =>
    taskCard(agenda, dispositions[agenda.key]?.taskStatus ?? baseTaskStatus(agenda))), [dispositions]);
  const doneEntries = useMemo(() => AGENDAS.filter(agenda => {
    const record = dispositions[agenda.key];
    return Boolean(record && record.taskStatus === "done");
  }), [dispositions]);

  const openReportAt = useCallback((agendaKey: string) => {
    const position = AGENDAS.findIndex(agenda => agenda.key === agendaKey);
    if (position < 0) return;
    setIndex(position);
    setNotice(null);
    setTasksOpen(false);
    setReportOpen(true);
    writeView("report");
  }, []);

  const openReport = useCallback(() => {
    if (!bubbleAgenda) return;
    openReportAt(bubbleAgenda.key);
  }, [bubbleAgenda, openReportAt]);

  const closeReport = useCallback(() => {
    setReportOpen(false);
    writeView("pas");
    requestAnimationFrame(() => {
      (openButtonRef.current ?? completionButtonRef.current)?.focus({ preventScroll: true });
    });
  }, []);

  const appendChat = useCallback((userLine: string, agentLine: string) => {
    const store = useDashboardStore.getState();
    const before = new Set(chatNodeIds());
    const base = nextEventId.current;
    nextEventId.current += 2;
    const events = [
      { type: "user_message", user: "User", text: userLine },
      { type: "assistant_message", content: agentLine },
    ] as SoulSSEEvent[];
    store.processEvents(events.map((event, offset) => ({ event, eventId: base + offset })));
    const added = chatNodeIds().filter(id => !before.has(id));
    for (const id of added) addedNodes.current.add(id);
    return added;
  }, []);

  const apply = useCallback((agenda: Agenda, actionId: string, outcome: StampOutcome | "answered",
    label: string, chat: [string, string], taskStatus: CardStatus, message: string) => {
    const now = Date.now();
    if (now - lastActionAt.current < ACTION_GUARD_MS) return;
    lastActionAt.current = now;
    if (dispositionsRef.current[agenda.key]) return;
    const nodeIds = appendChat(chat[0], chat[1]);
    const record: DispositionRecord = { actionId, outcome, label, message, taskStatus };
    const nextDispositions = { ...dispositionsRef.current, [agenda.key]: record };
    dispositionsRef.current = nextDispositions;
    setDispositions(nextDispositions);
    setNotice(null);
    const nextUndo: UndoState = { agendaKey: agenda.key, actionId, nodeIds };
    undoRef.current = nextUndo;
    setUndo(nextUndo);
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => {
      undoRef.current = null;
      setUndo(null);
    }, UNDO_MS);
  }, [appendChat]);

  const choose = useCallback((agenda: Agenda, label: string) => {
    apply(agenda, `option:${label}`, "answered", label,
      [`기간 칩은 ${label} 기준으로 두었습니다.`, `네, ${label} 기준으로 완료 목록을 정리하겠습니다.`],
      "done", `${label} 기준으로 정했습니다.`);
  }, [apply]);

  const stamp = useCallback((agenda: Agenda, value: AgendaStamp) => {
    apply(agenda, value.id, value.outcome, value.label, value.chat, value.taskStatus,
      STAMP_MESSAGES[`${agenda.key}:${value.id}`] ?? "처분했습니다.");
  }, [apply]);

  const submitInput = useCallback((agenda: Agenda, text: string, targetItem: number | null) => {
    if (agenda.kind === "question") {
      apply(agenda, "answer", "answered", text,
        [text, "말씀하신 내용으로 답을 남겼습니다."],
        "done", "답변을 남겼습니다.");
      return;
    }
    const userLine = targetItem ? `#${agenda.number} ${targetItem}번 항목: ${text}` : `#${agenda.number}: ${text}`;
    apply(agenda, targetItem ? `item:${targetItem}` : "input", "running", targetItem ? `${targetItem}번 항목 지시` : "지시",
      [userLine, "적어 주신 내용을 반영하겠습니다."], "running",
      targetItem ? `${targetItem}번 항목 지시를 보냈습니다.` : "지시를 보냈습니다.");
  }, [apply]);

  const undoLast = useCallback(() => {
    const record = undoRef.current;
    if (!record) return;
    const store = useDashboardStore.getState();
    if (store.tree) {
      const remove = new Set(record.nodeIds);
      const nextTree = { ...store.tree, children: store.tree.children.filter(child => !remove.has(child.id)) };
      useDashboardStore.setState({ tree: nextTree, treeVersion: store.treeVersion + 1 });
    }
    const nextDispositions = { ...dispositionsRef.current };
    delete nextDispositions[record.agendaKey];
    dispositionsRef.current = nextDispositions;
    setDispositions(nextDispositions);
    setNotice({ agendaKey: record.agendaKey, text: "되돌렸습니다." });
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    undoTimer.current = null;
    undoRef.current = null;
    setUndo(null);
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>('[data-testid="pas-rb-input"]');
      if (input && !input.disabled) { input.focus(); return; }
      (openButtonRef.current ?? completionButtonRef.current)?.focus({ preventScroll: true });
    });
  }, []);

  const replay = useCallback(() => {
    const store = useDashboardStore.getState();
    if (store.tree && addedNodes.current.size > 0) {
      const remove = new Set(addedNodes.current);
      const nextTree = { ...store.tree, children: store.tree.children.filter(child => !remove.has(child.id)) };
      useDashboardStore.setState({ tree: nextTree, treeVersion: store.treeVersion + 1 });
    }
    addedNodes.current.clear();
    dispositionsRef.current = {};
    setDispositions({});
    setChecks({});
    setNotice(null);
    setUndo(null);
    undoRef.current = null;
    setIndex(0);
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    undoTimer.current = null;
  }, []);

  const toggleCharacter = () => {
    setCharacterShown(value => !value);
  };

  const bubbleLayout = geometry?.reportBubble ?? null;
  const inBubble = Boolean(bubbleLayout && reportTarget);
  const bubbleStyle = inBubble && bubbleLayout && geometry?.body ? {
    position: "absolute", left: bubbleLayout.left - geometry.body.left,
    top: bubbleLayout.bottom - geometry.body.top, width: bubbleLayout.width,
    transform: "translateY(-100%)", maxHeight: bubbleLayout.maxHeight, "--pas-report-tail-left": `${bubbleLayout.tailLeft}px`,
  } as CSSProperties : undefined;

  const bubble = bubbleAgenda ? <article className="pas-report pas-rb-bubble" data-bubble={inBubble || undefined}
    data-testid="pas-rb-bubble" style={bubbleStyle}>
    <div className="pas-report-sheet pas-rb-bubble-sheet">
      <div className="pas-rb-bubble-head">
        <button type="button" className="pas-rb-bubble-title" onClick={openReport}>{bubbleAgenda.title}</button>
        <DashboardIconCap appearance="bare" label="보고 창 크게 열기" onClick={openReport}>
          <Maximize2 className="size-4" strokeWidth={1.5} aria-hidden="true" />
        </DashboardIconCap>
      </div>
      <div className="pas-rb-bubble-meta">
        <span className="pas-rb-bubble-count">{bubbleCount}</span>
        <span className="pas-rb-bubble-number">#{bubbleAgenda.number}</span>
        <StatusChip label={bubbleAgenda.statusLabel} tone={bubbleAgenda.statusTone} />
      </div>
      <p className="pas-rb-bubble-request">{bubbleAgenda.request}</p>
      <div className="pas-rb-bubble-actions">
        <Button ref={openButtonRef} variant="default" size="sm" data-testid="pas-rb-open" onClick={openReport}>보고 창 열기</Button>
      </div>
    </div>
    {inBubble ? <span className="pas-report-tail" data-direction={bubbleLayout?.tailDirection === "right" ? "right" : undefined} /> : null}
  </article> : null;

  const completion = <article className="pas-report pas-rb-bubble pas-rb-complete" data-bubble={inBubble || undefined}
    data-testid="pas-rb-complete" style={bubbleStyle}>
    <div className="pas-report-sheet pas-rb-bubble-sheet">
      <p className="pas-rb-complete-title">다섯 건을 모두 처분했습니다.</p>
      <p className="pas-rb-bubble-request">보류함은 {HOLD_COUNT}건 그대로입니다.</p>
      <div className="pas-rb-bubble-actions">
        {undo ? <Button ref={completionButtonRef} variant="outline" size="sm" onClick={undoLast}>되돌리기</Button>
          : <Button ref={completionButtonRef} variant="outline" size="sm" onClick={replay}>다시 시연하기</Button>}
      </div>
    </div>
    {inBubble ? <span className="pas-report-tail" data-direction={bubbleLayout?.tailDirection === "right" ? "right" : undefined} /> : null}
  </article>;

  const floating = bubbleAgenda ? bubble : completion;
  const inlineReport = !inBubble ? floating : null;
  const interior = <div className="pas-rb-chat-fill">
    {inlineReport}
    <ChatView presentation="manuscript" composerAnchorRef={composerAnchorRef} historyEnabled={false} />
  </div>;

  return <div ref={appRef} className="v3-shell persistent-session-screen pas-rb1707-screen" data-testid="pas-rb-screen"
    style={{ "--pas-baseline-bottom": geometry ? `calc(100% - ${geometry.lineY}px)` : undefined } as CSSProperties}>
    <V3GlobalToolbar headerRef={headerRef} variant="minimal" appearance="bare" agentName="서소영" agentOnly={isMobile}
      showHome={!isMobile} onOpenHome={() => undefined} onOpenConfig={() => undefined} />
    <main ref={mainRef} className="persistent-session-main">
      {interior}
    </main>
    {geometry?.body && <div aria-hidden="true" className="persistent-session-line" style={{ top: geometry.lineY, left: geometry.mainLeft - geometry.lineLeftReach, width: geometry.lineLeftReach }} />}
    {geometry?.body && <div ref={setReportTarget} data-testid="persistent-character" className="persistent-session-character"
      style={{ left: geometry.body.left, top: geometry.body.top, width: geometry.body.width, height: geometry.body.height }}>
      <SwayCharacter shown width={geometry.body.width} height={geometry.body.height} motionEnabled
        active={!reportOpen} assetBaseUrl="/characters/seosoyoung" />
    </div>}
    {geometry?.toggle && <div className="persistent-session-character-toggle"
      style={{ left: geometry.toggle.left + geometry.toggle.width / 2, top: geometry.toggle.top + geometry.toggle.height / 2 }}>
      <DashboardIconCap appearance="bare" label={characterShown ? "캐릭터 숨기기" : "캐릭터 표시"} onClick={toggleCharacter}>
        {characterShown ? <PersistentSessionPortraitOffIcon /> : <PersistentSessionPortraitIcon />}
      </DashboardIconCap>
    </div>}
    {!tasksOpen
      ? <div className="persistent-session-task-toggle">
        <DashboardIconCap appearance="bare" label="작업 목록" aria-expanded={false} onClick={() => setTasksOpen(true)}>
          <ListTodo className="size-5" strokeWidth={1.4} aria-hidden="true" />
        </DashboardIconCap>
      </div>
      : <aside className="persistent-session-tasks" aria-label="작업" data-testid="pas-rb-tasks">
        <div className="persistent-session-task-head">
          <h2>작업</h2>
          <DashboardIconCap appearance="bare" label="작업 목록 닫기" onClick={() => setTasksOpen(false)}>
            <X className="size-5" strokeWidth={1.4} aria-hidden="true" />
          </DashboardIconCap>
        </div>
        <div className="persistent-session-task-scroll">
          <PersistentSessionTaskList cards={cards} onOpenCard={cardId => {
            const agenda = AGENDAS.find(item => `mockup-card-${item.number}` === cardId);
            if (agenda) openReportAt(agenda.key);
          }} />
          <p className="pas-rb-drawer-meta">보류함 {HOLD_COUNT}개 (변동 없음)</p>
          {doneEntries.length > 0 ? <section className="pas-rb-done" data-testid="pas-rb-done-list">
            <h3>처분한 안건</h3>
            <ul>{doneEntries.map(agenda => {
              const record = dispositions[agenda.key]!;
              return <li key={agenda.key}>
                <span className="pas-rb-done-number">#{agenda.number}</span>
                <span className="pas-rb-done-title">{agenda.title}</span>
                <span className="pas-rb-done-badges">
                  <StatusChip label="완료" tone="done" />
                  {record.outcome === "reference" ? <Badge variant="info" size="sm">참고</Badge> : null}
                </span>
              </li>;
            })}</ul>
          </section> : null}
        </div>
      </aside>}
    {reportOpen ? <PasReviewReportDialog agendas={AGENDAS} index={index} dispositions={dispositions} notice={notice}
      undoAvailable={Boolean(undo)} checks={checks} onNavigate={setIndex} onChoose={choose} onStamp={stamp}
      onInput={submitInput} onCheck={(agendaKey, itemId, confirmed) => setChecks(previous => ({
        ...previous, [`${agendaKey}:${itemId}`]: confirmed,
      }))}
      onUndo={undoLast} onClose={closeReport} onOpenDocument={setDocId} /> : null}
    <DocumentReaderDialog documentId={docId} onClose={() => setDocId(null)} />
    {inBubble && reportTarget && floating ? createPortal(floating, reportTarget) : null}
  </div>;
}
