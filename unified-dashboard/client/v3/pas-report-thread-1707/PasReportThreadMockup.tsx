import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, DashboardIconCap, PersistentSessionPortraitIcon, PersistentSessionPortraitOffIcon, SwayCharacter, useDashboardStore, useIsMobile } from "@seosoyoung/soul-ui";
import { ChatInputComposer } from "@seosoyoung/soul-ui/components/chat/ChatInputComposer";
import { ChatInputEditor } from "@seosoyoung/soul-ui/components/chat/ChatInputEditor";
import { ChatMessageItem } from "@seosoyoung/soul-ui/components/chat/ChatMessageItem";
import type { ChatMessage } from "@seosoyoung/soul-ui/lib/flatten-tree";
import { ListTodo, X } from "lucide-react";
import { PersistentSessionTaskList } from "../PersistentSessionTaskList";
import { V3GlobalToolbar } from "../V3GlobalToolbar";
import { usePersistentSessionGeometry } from "../use-persistent-session-geometry";
import "../persistent-session-screen.css";
import "../persistent-report.css";
import { PasReportBubble } from "./PasReportBubble";
import { PasReportThreadReport, type EvidenceView } from "./PasReportThreadReport";
import type { DecisionTarget, QuestionMode } from "./PasThreadDecideBox";
import {
  AGENDA_FIXTURES,
  INITIAL_CHAT,
  INITIAL_HOLD_COUNT,
  chatMessageText,
  cloneAgendas,
  taskCardsFor,
  type Agenda,
  type AgendaStatus,
  type CheckItem,
  type DispositionId,
  type Evidence,
  type ThreadEvent,
} from "./pas-report-thread-1707-data";
import "./v3-pas-report-thread-1707.css";

type ChatLine = { id: string; role: "user" | "assistant"; content: string; timestamp: number };
type UndoRecord = { agendaId: string; agendaNumber: number; status: AgendaStatus; answer: string | null; kept: boolean; snoozedLabel?: string | null; eventIds: string[]; chatIds: string[]; isSnooze?: true; seq: number };

function readReportRoute() {
  try {
    if (window.location.hash === "#report") return true;
    if (new URLSearchParams(window.location.search).get("view") === "report") return true;
    if (window.parent !== window && new URLSearchParams(window.parent.location.search).get("view") === "report") return true;
    if (window.parent !== window && window.parent.location.hash === "#report") return true;
  } catch { return false; }
  return false;
}

function toChatMessage(line: ChatLine): ChatMessage {
  return { id: line.id, role: line.role, content: line.content, treeNodeId: line.id,
    treeNodeType: line.role === "user" ? "user_message" : "assistant_message", timestamp: line.timestamp };
}

const STATUS_AFTER: Record<DispositionId, AgendaStatus> = {
  approve: "done",
  keep: "done",
  done: "done",
  recheck3: "awaiting_verification",
};

export function PasReportThreadMockup() {
  const [agendas, setAgendas] = useState<Agenda[]>(() => cloneAgendas());
  const [activeId, setActiveId] = useState(AGENDA_FIXTURES[0].id);
  const [reportOpen, setReportOpen] = useState(readReportRoute);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [showCharacter, setShowCharacter] = useState(true);
  const [checks, setChecks] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const agenda of AGENDA_FIXTURES) for (const event of agenda.events) {
      if (event.kind === "result") for (const check of event.checks) initial[`${agenda.id}:${check.id}`] = check.done;
    }
    return initial;
  });
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, string | null>>({});
  const [instruction, setInstruction] = useState("");
  const [target, setTarget] = useState<DecisionTarget>(null);
  const [undo, setUndo] = useState<UndoRecord | null>(null);
  const [evidenceView, setEvidenceView] = useState<EvidenceView>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [chat, setChat] = useState<ChatLine[]>(() => INITIAL_CHAT.map((line) => ({ ...line })));
  const [chatText, setChatText] = useState("");
  const [characterTarget, setCharacterTarget] = useState<HTMLDivElement | null>(null);

  const appRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const composerAnchorRef = useRef<HTMLDivElement>(null);
  const openTriggerRef = useRef<HTMLButtonElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const lastAction = useRef({ key: "", at: 0 });
  const seq = useRef(0);
  const isMobile = useIsMobile();
  const geometry = usePersistentSessionGeometry({ app: appRef, header: headerRef, main: mainRef, composer: composerAnchorRef, enabled: true, showCharacter });
  const activeAgenda = agendas.find((agenda) => agenda.id === activeId) ?? agendas[0];
  const pending = agendas.filter((agenda) => agenda.status === "review" && !agenda.snoozedLabel);
  const pendingIndex = pending.findIndex((agenda) => agenda.id === activeAgenda.id);
  const taskCards = useMemo(() => taskCardsFor(agendas), [agendas]);
  const keptAgendas = useMemo(() => agendas.filter((agenda) => agenda.keptAsReference === true), [agendas]);

  useEffect(() => {
    useDashboardStore.getState().setActiveSessionSummary({ status: "completed" } as never);
    return () => useDashboardStore.getState().setActiveSessionSummary(null);
  }, []);

  useEffect(() => {
    const sync = () => setReportOpen(readReportRoute());
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => { window.removeEventListener("hashchange", sync); window.removeEventListener("popstate", sync); };
  }, []);

  useLayoutEffect(() => {
    const scroll = chatScrollRef.current;
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }, [chat.length]);

  useEffect(() => {
    document.body.classList.toggle("pas-rt1707-open", reportOpen);
    return () => document.body.classList.remove("pas-rt1707-open");
  }, [reportOpen]);

  const setCharacter = useCallback((element: HTMLDivElement | null) => setCharacterTarget(element), []);
  // Blocks only a repeated press of the same action; a different next action goes through.
  const guard = (key: string) => {
    const now = Date.now();
    if (lastAction.current.key === key && now - lastAction.current.at < 400) return false;
    lastAction.current = { key, at: now };
    return true;
  };
  const openReport = () => {
    setReportOpen(true);
    setTasksOpen(false);
    try { if (window.location.hash !== "#report") window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#report`); } catch { /* 주소를 바꿀 수 없어도 화면은 연다. */ }
  };
  const openBubbleReport = () => {
    if (pendingIndex < 0 && pending[0]) setActiveId(pending[0].id);
    openReport();
  };
  const closeReport = () => {
    setReportOpen(false);
    try { window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`); } catch { /* 주소를 되돌리지 못해도 닫는다. */ }
  };
  const selectAgenda = (id: string) => { setActiveId(id); setTarget(null); setInstruction(""); };
  const goAgenda = (delta: number) => {
    const index = agendas.findIndex((agenda) => agenda.id === activeId);
    const next = agendas[Math.min(agendas.length - 1, Math.max(0, index + delta))];
    if (next) selectAgenda(next.id);
  };
  const addChat = (line: ChatLine) => setChat((previous) => [...previous, line]);

  const dispose = (disposition: DispositionId) => {
    if (!guard(`dispose:${activeAgenda.id}:${disposition}`)) return;
    const agenda = activeAgenda;
    const nextStatus = STATUS_AFTER[disposition];
    const chatId = `chat-act-${++seq.current}`;
    const snapshot: UndoRecord = { agendaId: agenda.id, agendaNumber: agenda.number, status: agenda.status, answer: questionAnswers[agenda.id] ?? null,
      kept: agenda.keptAsReference === true, eventIds: [], chatIds: [chatId], seq: ++seq.current };
    setAgendas((previous) => previous.map((item) => item.id === agenda.id
      ? { ...item, status: nextStatus, keptAsReference: disposition === "keep" ? true : item.keptAsReference === true }
      : item));
    if (disposition === "done" && agenda.question) setQuestionAnswers((previous) => ({ ...previous, [agenda.id]: "했어" }));
    addChat({ id: chatId, role: "assistant", content: chatMessageText(agenda, disposition), timestamp: Date.now() });
    setUndo(snapshot);
  };

  const chooseAnswer = (agenda: Agenda, label: string) => {
    if (!guard(`answer:${agenda.id}`) || (questionAnswers[agenda.id] ?? null) !== null) return;
    const chatId = `chat-act-${++seq.current}`;
    setQuestionAnswers((previous) => ({ ...previous, [agenda.id]: label }));
    setAgendas((previous) => previous.map((item) => item.id === agenda.id ? { ...item, status: "done" } : item));
    addChat({ id: chatId, role: "assistant", content: `#${agenda.number} ${agenda.title}의 답을 "${label}"로 받았습니다. 이 안건을 완료로 처분했습니다.`, timestamp: Date.now() });
    setUndo({ agendaId: agenda.id, agendaNumber: agenda.number, status: agenda.status, answer: null, kept: agenda.keptAsReference === true,
      eventIds: [], chatIds: [chatId], seq: ++seq.current });
  };

  const sendInstruction = (mode: QuestionMode) => {
    const text = instruction.trim();
    if (!text || !guard(`send:${activeAgenda.id}`)) return;
    const label = target ? `${target.label}: ` : "";
    const eventId = `event-${++seq.current}`;
    const chatId = `chat-act-${++seq.current}`;
    const event: ThreadEvent = { id: eventId, kind: "comment", at: "방금", author: "user", text: `${label}${text}` };
    const isQuestion = activeAgenda.question?.kind === "choice" && activeAgenda.status === "review" && !activeAgenda.snoozedLabel;
    const followup = isQuestion && mode === "followup";
    const replyId = `event-${++seq.current}`;
    const reply: ThreadEvent = { id: replyId, kind: "comment", at: "방금", author: "agent", agent: activeAgenda.agent,
      text: "최근 완료 기록을 기준으로 비교했습니다. 선택지는 그대로 열어 두겠습니다." };
    setAgendas((previous) => previous.map((agenda) => agenda.id === activeAgenda.id
      ? { ...agenda, status: followup ? "review" : isQuestion ? "done" : "running", snoozedLabel: null, events: [...agenda.events, event, ...(followup ? [reply] : [])] } : agenda));
    if (isQuestion && !followup) setQuestionAnswers((previous) => ({ ...previous, [activeAgenda.id]: text }));
    addChat({ id: chatId, role: "user", content: `#${activeAgenda.number} ${label}${text}`, timestamp: Date.now() });
    setUndo({ agendaId: activeAgenda.id, agendaNumber: activeAgenda.number, status: activeAgenda.status, answer: questionAnswers[activeAgenda.id] ?? null,
      kept: activeAgenda.keptAsReference === true, snoozedLabel: activeAgenda.snoozedLabel, eventIds: [eventId, ...(followup ? [replyId] : [])], chatIds: [chatId], seq: ++seq.current });
    setInstruction("");
    setTarget(null);
  };

  const undoLast = () => {
    if (!undo) return;
    setAgendas((previous) => previous.map((agenda) => agenda.id === undo.agendaId
      ? { ...agenda, status: undo.status, keptAsReference: undo.kept, snoozedLabel: undo.snoozedLabel ?? null,
        events: agenda.events.filter((event) => !undo.eventIds.includes(event.id)) } : agenda));
    setQuestionAnswers((previous) => ({ ...previous, [undo.agendaId]: undo.answer }));
    setChat((previous) => previous.filter((line) => !undo.chatIds.includes(line.id)));
    selectAgenda(undo.agendaId);
    setUndo(null);
  };

  const snooze = (label: string) => {
    const agenda = activeAgenda;
    setUndo({ agendaId: agenda.id, agendaNumber: agenda.number, status: agenda.status, answer: questionAnswers[agenda.id] ?? null,
      kept: agenda.keptAsReference === true, snoozedLabel: agenda.snoozedLabel, eventIds: [], chatIds: [], isSnooze: true, seq: ++seq.current });
    setAgendas((previous) => previous.map((item) => item.id === agenda.id ? { ...item, snoozedLabel: label } : item));
    const next = pending[pendingIndex + 1] ?? pending.find((item) => item.id !== agenda.id);
    if (next) selectAgenda(next.id);
  };
  const unsnooze = () => {
    setAgendas((previous) => previous.map((item) => item.id === activeAgenda.id ? { ...item, snoozedLabel: null } : item));
    setUndo(null);
  };
  const simulateEvent = () => {
    const event: ThreadEvent = { id: `event-${++seq.current}`, kind: "session", at: "방금", agent: activeAgenda.agent,
      summary: "설치 단계를 확인하고 다음 검증을 진행합니다.", turns: [] };
    setAgendas((previous) => previous.map((item) => item.id === activeAgenda.id ? { ...item, events: [...item.events, event] } : item));
  };

  const instruct = (agenda: Agenda, check: CheckItem) => {
    const result = agenda.events.find((event) => event.kind === "result");
    const index = result?.kind === "result" ? result.checks.findIndex((item) => item.id === check.id) : -1;
    setActiveId(agenda.id);
    setTarget({ checkId: check.id, label: `${index >= 0 ? index + 1 : 1}번 항목` });
  };

  const openDocument = (id: string) => setDocumentId(id);
  const openTaskCard = (cardId: string) => {
    const agenda = agendas.find((item) => item.id === cardId);
    if (agenda) selectAgenda(agenda.id);
    openReport();
  };

  // 결재를 마친 안건을 보고 있는 동안에도 말풍선은 다음 대기 안건을 가리킨다. 처분이
  // 반영되면 순번이 줄고, 대화와 작업 목록도 같은 안건을 본다.
  const bubbleAgenda = pendingIndex >= 0 ? activeAgenda : pending[0] ?? activeAgenda;
  const bubbleIndex = pending.findIndex((item) => item.id === bubbleAgenda.id);
  const bubblePosition = pendingIndex >= 0 ? pendingIndex + 1 : pending.length > 0 ? 1 : Math.max(1, pending.length);
  const undoLabel = undo && (undo.agendaId === activeAgenda.id
    ? "되돌리기"
    : `#${undo.agendaNumber} ${undo.isSnooze ? "미루기 " : ""}되돌리기`);
  const goBubble = (delta: number) => {
    const next = pending[Math.min(pending.length - 1, Math.max(0, bubbleIndex + delta))];
    if (next && next.id !== activeAgenda.id) selectAgenda(next.id);
  };

  return <div ref={appRef} className="v3-shell persistent-session-screen pas-rt1707-screen" data-testid="pas-report-thread-screen">
    <V3GlobalToolbar headerRef={headerRef} variant="minimal" appearance="bare" sessionName="서소영 영구 세션"
      agentName="서소영" agentOnly={isMobile} showHome={!isMobile} onOpenHome={() => undefined} onOpenConfig={() => undefined} />
    <main ref={mainRef} className="persistent-session-main">
      <PasReportBubble agenda={bubbleAgenda} position={bubblePosition} total={pending.length}
        layout={geometry?.reportBubble ?? null} body={geometry?.body ?? null} target={characterTarget} inline={!geometry?.reportBubble}
        onOpen={openBubbleReport} onPrev={() => goBubble(-1)} onNext={() => goBubble(1)}
        canPrev={bubbleIndex > 0} canNext={bubbleIndex >= 0 && bubbleIndex < pending.length - 1} openTriggerRef={openTriggerRef} />
      <div data-slot="chat-root" data-chat-presentation="manuscript" data-testid="chat-view"
        className="-mx-1 flex h-full min-h-0 flex-col overflow-hidden px-1 pb-3 pt-3">
        <div ref={chatScrollRef} className="pas-rt1707-chat-scroll" data-v3-selectable-content="true">
          {chat.map((line) => <ChatMessageItem key={line.id} msg={toChatMessage(line)} presentation="manuscript" />)}
        </div>
        <div data-testid="chat-input" className="shrink-0">
          <div ref={composerAnchorRef} data-slot="chat-composer-anchor" className="-mx-1 px-1 pt-3">
            <ChatInputComposer presentation="manuscript">
              <ChatInputEditor presentation="manuscript" inputLabel="메시지" text={chatText} onChangeText={setChatText}
                onSend={() => { const text = chatText.trim(); if (!text) return; addChat({ id: `chat-${++seq.current}`, role: "user", content: text, timestamp: Date.now() }); setChatText(""); }}
                placeholder="메시지를 적으세요" buttonLabel="보내기" modeIcon="" modeLabel="" borderColor="" buttonVariant="default"
                disabled={chatText.trim().length === 0} textareaDisabled={false} />
            </ChatInputComposer>
          </div>
        </div>
      </div>
    </main>
    {geometry?.body && showCharacter ? <div ref={setCharacter} data-testid="persistent-character" className="persistent-session-character"
      style={{ left: geometry.body.left, top: geometry.body.top, width: geometry.body.width, height: geometry.body.height }}>
      <SwayCharacter shown width={geometry.body.width} height={geometry.body.height} motionEnabled={false} active assetBaseUrl="/characters/seosoyoung" />
    </div> : null}
    {geometry?.body && geometry.lineLeftReach > 0 ? <div aria-hidden="true" className="persistent-session-line"
      style={{ top: geometry.lineY, left: geometry.mainLeft - geometry.lineLeftReach, width: geometry.lineLeftReach }} /> : null}
    {geometry?.toggle ? <div className="persistent-session-character-toggle" style={{ left: geometry.toggle.left + geometry.toggle.width / 2, top: geometry.toggle.top + geometry.toggle.height / 2 }}>
      <DashboardIconCap appearance="bare" label={showCharacter ? "캐릭터 숨기기" : "캐릭터 표시"} onClick={() => setShowCharacter((value) => !value)}>
        {showCharacter ? <PersistentSessionPortraitOffIcon /> : <PersistentSessionPortraitIcon />}
      </DashboardIconCap>
    </div> : null}
    {!tasksOpen ? <div className="persistent-session-task-toggle">
      <DashboardIconCap appearance="bare" label="작업 목록" aria-expanded={false} onClick={() => setTasksOpen(true)}><ListTodo className="size-5" strokeWidth={1.4} absoluteStrokeWidth /></DashboardIconCap>
    </div> : <aside className="persistent-session-tasks" aria-label="작업">
      <div className="persistent-session-task-head"><h2>작업</h2>
        <DashboardIconCap appearance="bare" label="작업 목록 닫기" onClick={() => setTasksOpen(false)}><X className="size-5" strokeWidth={1.4} absoluteStrokeWidth /></DashboardIconCap>
      </div>
      <div className="persistent-session-task-scroll">
        <PersistentSessionTaskList cards={taskCards} onOpenCard={openTaskCard} />
        {keptAgendas.length > 0 ? <section className="pas-rt1707-kept" aria-label="참고 문서">
          <div className="pas-rt1707-kept-head"><h3>참고 문서</h3><span>{keptAgendas.length}개</span></div>
          <div className="pas-rt1707-kept-list">
            {keptAgendas.map((agenda) => <button key={agenda.id} type="button" className="pas-rt1707-kept-card"
              data-card-id={agenda.id} onClick={() => openTaskCard(agenda.id)}
              aria-label={`${agenda.number}번 ${agenda.title} 참고 문서 열기`}>
              <span className="pas-rt1707-kept-number">#{agenda.number}</span>
              <span className="pas-rt1707-kept-title">{agenda.title}</span>
              <Badge variant="info" size="sm">참고</Badge>
            </button>)}
          </div>
        </section> : null}
      </div>
      <p className="pas-rt1707-hold-note">보류함 {INITIAL_HOLD_COUNT}개 (변동 없음)</p>
    </aside>}
    <PasReportThreadReport agendas={agendas} activeId={activeAgenda.id} open={reportOpen} onSelect={selectAgenda} onClose={closeReport} openTriggerRef={openTriggerRef}
      checks={checks} questionAnswers={questionAnswers}
      onToggleCheck={(agendaId, checkId) => setChecks((previous) => ({ ...previous, [`${agendaId}:${checkId}`]: !previous[`${agendaId}:${checkId}`] }))}
      onInstruct={instruct} onChooseAnswer={chooseAnswer}
      target={target} onClearTarget={() => setTarget(null)} instruction={instruction} onChangeInstruction={setInstruction} onSendInstruction={sendInstruction}
      onDispose={dispose} undoLabel={undoLabel} undoSeq={undo?.seq ?? 0} onUndo={undoLast}
      onSnooze={snooze} onUnsnooze={unsnooze} onSimulate={simulateEvent}
      evidenceView={evidenceView} onOpenEvidence={(evidence: Evidence, trigger: HTMLElement | null) => setEvidenceView({ evidence, trigger })}
      onCloseEvidence={() => setEvidenceView(null)} documentId={documentId} onOpenDocument={openDocument} onCloseDocument={() => setDocumentId(null)} />
  </div>;
}
