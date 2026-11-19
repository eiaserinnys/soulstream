import { useEffect, useRef, useState } from "react";
import { useDashboardStore, type SessionSummary } from "@seosoyoung/soul-ui";
import type { CardDetail } from "@seosoyoung/soul-ui/cards/card-types";
import { ApprovalDeskToolbar, type DashboardScreen } from "./ApprovalDeskToolbar";
import { ApprovalDeskScreen, type DeskAction } from "./ApprovalDeskScreen";
import { HomePlannerScreen } from "./HomePlannerScreen";
import { PasBriefingScreen } from "./PasBriefingScreen";
import { DocumentReaderDialog } from "../DocumentReaderDialog";
import { CardWorkspace } from "../CardWorkspace";
import { useMobilePlannerMode } from "../MobilePlannerTabs";
import type { MobilePlannerTab } from "../mobile-planner-state";
import type { DispositionKind } from "./ApprovalDeskStampBar";
import type { QuestionAction } from "./ApprovalDeskDocument";
import {
  COMPLETED_CARDS, FOLDERS, ON_HOLD_CARDS, PENDING_DOCS, PROGRESS_CARDS, QUEUE_CARDS,
  pendingCard, portraitUrl, toCardRow, type AgentAssignee, type PendingDoc, type ScenarioCard,
} from "./approval-desk-data";
import "../v3-folder-workspace.css";
import "../v3-postit-cards.css";
import "../v3-card-board.css";
import "./v3-approval-desk-1707.css";

const MOCK_NOW = "2026-11-19T09:00:00.000Z";

const PAS_SESSION: SessionSummary = {
  agentSessionId: "mock-pas-seosoyoung",
  displayName: "PAS 대화",
  status: "running",
  eventCount: 3,
  agentId: "seosoyoung",
  agentName: "서소영",
  nodeId: "eiaserinnys",
  modelLabel: "Sol",
  backend: "codex",
  agentPortraitUrl: portraitUrl("seosoyoung"),
  createdAt: MOCK_NOW,
  updatedAt: MOCK_NOW,
  prompt: "결재 데스크 브리핑",
};

function sessionFor(assignee: AgentAssignee, cardId: string): SessionSummary {
  return {
    agentSessionId: `mock-${cardId}-${assignee.agentId}`,
    displayName: assignee.session,
    status: "completed",
    eventCount: 0,
    agentId: assignee.agentId,
    agentName: assignee.name,
    nodeId: "eiaserinnys",
    modelLabel: "Sol",
    backend: "codex",
    agentPortraitUrl: portraitUrl(assignee.agentId),
    createdAt: MOCK_NOW,
    updatedAt: MOCK_NOW,
    prompt: assignee.role,
  };
}

function linkedSession(assignee: AgentAssignee, cardId: string): CardDetail["sessions"][number] {
  const session = sessionFor(assignee, cardId);
  return {
    sessionId: session.agentSessionId,
    cardId,
    displayName: session.displayName ?? null,
    nodeId: session.nodeId!,
    agentId: assignee.agentId,
    status: "completed",
    createdAt: MOCK_NOW,
    updatedAt: MOCK_NOW,
    callerSessionId: null,
  };
}

function detailForPending(doc: PendingDoc): CardDetail {
  const row = toCardRow(pendingCard(doc));
  const session = sessionFor(doc.assignee, row.id);
  return {
    card: row,
    reports: doc.kind === "review" ? [{
      id: `report-${doc.number}`, title: doc.title, format: "markdown",
      body: doc.request, sessionId: session.agentSessionId, createdAt: row.createdAt,
    }] : [],
    questions: doc.kind === "question" ? [{
      id: `question-${doc.number}`, text: doc.title,
      options: doc.options?.map(option => option.label) ?? null,
      answer: null, askedAt: row.createdAt, answeredAt: null,
    }] : [],
    sessions: [linkedSession(doc.assignee, row.id)],
    comments: doc.messages.map((message, index) => ({
      id: `comment-${doc.number}-${index}`, cardId: row.id,
      authorKind: message.role === "user" ? "user" : "agent",
      authorId: message.role === "user" ? "director" : doc.assignee.agentId,
      sessionId: message.role === "user" ? null : session.agentSessionId,
      kind: "comment", body: message.text, createdAt: row.createdAt,
    })),
    notes: [],
    nowHistory: [],
  };
}

function detailForCard(card: ScenarioCard): CardDetail {
  const row = toCardRow(card);
  const session = sessionFor(card.assignee, row.id);
  return {
    card: row,
    reports: [{
      id: `report-${card.number}`, title: card.title, format: "markdown",
      body: card.activity, sessionId: session.agentSessionId, createdAt: row.createdAt,
    }],
    questions: [],
    sessions: [linkedSession(card.assignee, row.id)],
    comments: [{
      id: `comment-${card.number}`, cardId: row.id,
      authorKind: card.activityKind === "instruction" ? "user" : "agent",
      authorId: card.activityKind === "instruction" ? "director" : card.assignee.agentId,
      sessionId: card.activityKind === "instruction" ? null : session.agentSessionId,
      kind: "comment", body: card.activity, createdAt: row.createdAt,
    }],
    notes: [],
    nowHistory: [],
  };
}

function readScreen(): DashboardScreen {
  const hash = window.location.hash.replace(/^#/, "");
  return hash === "home" || hash === "pas" || hash === "board" ? hash : "desk";
}

function pendingOrder(doc: PendingDoc): number {
  return PENDING_DOCS.findIndex(item => item.id === doc.id);
}

function progressCard(doc: PendingDoc, detail?: string): ScenarioCard {
  return {
    ...pendingCard(doc),
    status: "running",
    activityKind: "instruction",
    activity: detail ? `${detail}을 보냈습니다.` : "보완 지시를 받았습니다.",
  };
}

function completedCard(doc: PendingDoc, reference: boolean, detail?: string): ScenarioCard {
  return {
    ...pendingCard(doc),
    status: "done",
    activityKind: "report",
    activity: reference ? doc.referenceSummary : detail ? `${detail}로 답했습니다.` : "승인 완료로 넘겼습니다.",
    reference,
  };
}

/** 시안 A. 홈 플래너, 결재 데스크, PAS, 보드와 참고 서재를 한 화면 흐름으로 묶는다. */
export function ApprovalDeskDashboardMockup() {
  const [screen, setScreen] = useState<DashboardScreen>(readScreen);
  const [pending, setPending] = useState<PendingDoc[]>(PENDING_DOCS);
  const [progress, setProgress] = useState<ScenarioCard[]>(PROGRESS_CARDS);
  const [completed, setCompleted] = useState<ScenarioCard[]>(COMPLETED_CARDS);
  const [deskId, setDeskId] = useState<string>(PENDING_DOCS[0]!.id);
  const [lastAction, setLastAction] = useState<DeskAction | null>(null);
  const [questionAction, setQuestionAction] = useState<QuestionAction | null>(null);
  const [referenceView, setReferenceView] = useState(false);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<CardDetail | null>(null);
  const [overlaySession, setOverlaySession] = useState<SessionSummary | undefined>(undefined);
  const [mobileTab, setMobileTab] = useState<MobilePlannerTab>("projects");
  const overlayTrigger = useRef<HTMLElement | null>(null);
  // 겹 눌림 한 번이 다음 서류까지 넘기지 않도록, 최근 처분 뒤 400ms 동안 모든 처분을 막는다.
  const lastDispose = useRef({ id: null as string | null, at: 0 });
  const mobileMode = useMobilePlannerMode();

  useEffect(() => {
    if (!useDashboardStore.getState().activeSessionKey) {
      useDashboardStore.getState().setActiveSession(PAS_SESSION.agentSessionId);
      useDashboardStore.getState().setActiveSessionSummary(PAS_SESSION);
    }
  }, []);

  useEffect(() => {
    const onHash = () => {
      const next = readScreen();
      setScreen(next);
      if (next === "board") setReferenceView(false);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const deskDocs = pending.filter(doc => !doc.scheduledUntil);
  const current = deskDocs.find(doc => doc.id === deskId) ?? null;
  useEffect(() => {
    if (!current && deskDocs.length > 0) setDeskId(deskDocs[0]!.id);
  }, [current, deskDocs]);
  useEffect(() => {
    setQuestionAction(null);
  }, [deskId]);

  const navigate = (next: DashboardScreen) => {
    setScreen(next);
    setReferenceView(false);
    if (window.location.hash !== `#${next}`) window.location.hash = next;
  };

  const restorePasSession = () => {
    useDashboardStore.getState().setActiveSession(PAS_SESSION.agentSessionId);
    useDashboardStore.getState().setActiveSessionSummary(PAS_SESSION);
  };

  const dispose = (doc: PendingDoc, kind: DispositionKind, detail?: string) => {
    const now = Date.now();
    if (now - lastDispose.current.at < 400) return;
    if (!pending.some(item => item.id === doc.id)) return;
    lastDispose.current = { id: doc.id, at: now };
    setLastAction({ doc, kind, detail });
    const index = deskDocs.findIndex(item => item.id === doc.id);
    const next = deskDocs[index + 1] ?? deskDocs[index - 1] ?? null;
    setDeskId(next?.id ?? "");
    setQuestionAction(null);
    if (kind === "snooze") {
      setPending(items => items.map(item => item.id === doc.id ? { ...item, scheduledUntil: detail ?? "다시 보기" } : item));
      return;
    }
    setPending(items => items.filter(item => item.id !== doc.id));
    if (kind === "supplement") setProgress(items => [progressCard(doc, detail), ...items]);
    else setCompleted(items => [completedCard(doc, kind === "reference", detail), ...items]);
  };

  const submitQuestionAction = (doc: PendingDoc, action: QuestionAction, note: string) => {
    const label = action === "different" ? "다르게 답하기" : "되묻기";
    setQuestionAction(null);
    dispose(doc, "supplement", `${label}: ${note}`);
  };

  const undo = () => {
    if (!lastAction) return;
    lastDispose.current = { id: null, at: 0 };
    const { doc, kind } = lastAction;
    setPending(items => {
      const restored = { ...doc, scheduledUntil: undefined };
      if (items.some(item => item.id === doc.id)) {
        return items.map(item => item.id === doc.id ? restored : item);
      }
      return [...items, restored].sort((left, right) => pendingOrder(left) - pendingOrder(right));
    });
    if (kind === "supplement") setProgress(items => items.filter(card => card.id !== `card-${doc.number}`));
    if (kind === "reference" || kind === "approve") setCompleted(items => items.filter(card => card.id !== `card-${doc.number}`));
    setDeskId(doc.id);
    setQuestionAction(null);
    setLastAction(null);
  };

  const resetDemo = () => {
    lastDispose.current = { id: null, at: 0 };
    setPending(PENDING_DOCS);
    setProgress(PROGRESS_CARDS);
    setCompleted(COMPLETED_CARDS);
    setDeskId(PENDING_DOCS[0]!.id);
    setLastAction(null);
    setQuestionAction(null);
    setOverlay(null);
    setOverlaySession(undefined);
    setReferenceView(false);
    navigate("desk");
  };

  const activateOverlay = (detail: CardDetail, assignee: AgentAssignee, trigger: HTMLElement) => {
    overlayTrigger.current = trigger;
    const session = sessionFor(assignee, detail.card.id);
    useDashboardStore.getState().setActiveSession(session.agentSessionId);
    useDashboardStore.getState().setActiveSessionSummary(session);
    setOverlaySession(session);
    setMobileTab("projects");
    setOverlay(detail);
  };

  const openPending = (doc: PendingDoc, trigger: HTMLElement) => {
    activateOverlay(detailForPending(doc), doc.assignee, trigger);
  };

  const openCard = (card: ScenarioCard, trigger: HTMLElement) => {
    activateOverlay(detailForCard(card), card.assignee, trigger);
  };

  const closeOverlay = () => {
    setOverlay(null);
    setOverlaySession(undefined);
    restorePasSession();
    requestAnimationFrame(() => overlayTrigger.current?.focus());
  };

  const toggleReference = () => {
    const next = !referenceView;
    setReferenceView(next);
    if (next && screen !== "home") {
      setScreen("home");
      if (window.location.hash !== "#home") window.location.hash = "home";
    }
  };

  return <>
    <ApprovalDeskToolbar screen={screen} deskCount={deskDocs.length} onNavigate={navigate} />
    {screen === "desk" ? <ApprovalDeskScreen docs={deskDocs} current={current} questionAction={questionAction}
      onSelect={setDeskId} onDispose={dispose} onUndo={undo} lastAction={lastAction}
      onOpenHome={() => navigate("home")} onOpenOverlay={openPending}
      onQuestionAction={setQuestionAction} onQuestionActionSubmit={submitQuestionAction}
      onQuestionActionCancel={() => setQuestionAction(null)} onOpenDocument={setDocumentId}
      onReset={resetDemo} /> : null}
    {screen === "home" || screen === "board" ? <HomePlannerScreen pending={pending}
      progress={progress} queue={QUEUE_CARDS} onHold={ON_HOLD_CARDS} completed={completed}
      folders={FOLDERS} referenceView={referenceView} boardView={screen === "board"}
      onToggleReference={toggleReference} onToggleBoard={() => navigate(screen === "board" ? "home" : "board")}
      onOpenDesk={() => navigate("desk")} onOpenPending={openPending} onOpenCard={openCard} /> : null}
    {screen === "pas" ? <PasBriefingScreen deskCount={deskDocs.length} onOpenDesk={() => navigate("desk")} /> : null}
    {overlay ? <CardWorkspace cardId={overlay.card.id} sampleDetail={overlay} folders={FOLDERS}
      onClose={closeOverlay} onCloseChat={() => setMobileTab("today")}
      onOpenSession={session => {
        useDashboardStore.getState().setActiveSession(session.agentSessionId);
        useDashboardStore.getState().setActiveSessionSummary(session);
        setOverlaySession(session);
        setMobileTab("chat");
      }}
      mobileMode={mobileMode} mobileTab={mobileTab} activeSession={overlaySession}
      chatInputDisabled historyEnabled={false} sessionStreamActive={false}
      sessionConnectionStatus="disconnected" reconnectSession={() => {}}
      onAcknowledgedReview={() => {}} loadDisplaySettings={false} /> : null}
    <DocumentReaderDialog documentId={documentId} onClose={() => setDocumentId(null)} />
  </>;
}
