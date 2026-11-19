import { useEffect, useRef, useState } from "react";
import { ApprovalDeskToolbar, type DashboardScreen } from "./ApprovalDeskToolbar";
import { ApprovalDeskScreen, type DeskAction } from "./ApprovalDeskScreen";
import { HomePlannerScreen } from "./HomePlannerScreen";
import { PasBriefingScreen } from "./PasBriefingScreen";
import { CardSessionOverlay, type OverlayDetail } from "./CardSessionOverlay";
import type { DispositionKind } from "./ApprovalDeskStampBar";
import {
  COMPLETED_CARDS, ON_HOLD_CARDS, PENDING_DOCS, PROGRESS_CARDS, QUEUE_CARDS,
  pendingCard, type PendingDoc, type ScenarioCard,
} from "./approval-desk-data";
import "../v3-postit-cards.css";
import "../v3-card-board.css";
import "./v3-approval-desk-1707.css";

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
    activity: reference ? "참고 서재로 갈무리했습니다." : detail ? `${detail}로 답했습니다.` : "승인 완료로 넘겼습니다.",
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
  const [referenceView, setReferenceView] = useState(false);
  const [overlay, setOverlay] = useState<OverlayDetail | null>(null);
  const overlayTrigger = useRef<HTMLElement | null>(null);

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

  const navigate = (next: DashboardScreen) => {
    setScreen(next);
    setReferenceView(false);
    if (window.location.hash !== `#${next}`) window.location.hash = next;
  };

  const dispose = (doc: PendingDoc, kind: DispositionKind, detail?: string) => {
    setLastAction({ doc, kind, detail });
    const index = deskDocs.findIndex(item => item.id === doc.id);
    const next = deskDocs[index + 1] ?? deskDocs[index - 1] ?? null;
    setDeskId(next?.id ?? "");
    if (kind === "snooze") {
      setPending(items => items.map(item => item.id === doc.id ? { ...item, scheduledUntil: detail ?? "다시 보기" } : item));
      return;
    }
    setPending(items => items.filter(item => item.id !== doc.id));
    if (kind === "supplement") setProgress(items => [progressCard(doc, detail), ...items]);
    else setCompleted(items => [completedCard(doc, kind === "reference", detail), ...items]);
  };

  const undo = () => {
    if (!lastAction) return;
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
    setLastAction(null);
  };

  const openPending = (doc: PendingDoc, trigger: HTMLElement) => {
    overlayTrigger.current = trigger;
    setOverlay({
      number: doc.number,
      title: doc.title,
      folder: doc.folder,
      statusLabel: doc.kindLabel,
      statusTone: doc.kind === "question" ? "question" : doc.kind === "task" ? "running" : "review",
      request: doc.request,
      checks: doc.checks?.map(check => ({ title: check.title, result: check.result })),
      assignee: doc.assignee,
      messages: doc.messages,
    });
  };

  const openCard = (card: ScenarioCard, trigger: HTMLElement) => {
    overlayTrigger.current = trigger;
    setOverlay({
      number: card.number,
      title: card.title,
      folder: card.folder,
      statusLabel: card.status === "done" ? (card.reference ? "참고" : "완료") : card.status === "on_hold" ? "보류" : "실행 중",
      statusTone: card.status === "done" ? "done" : card.status === "on_hold" ? "open" : "running",
      request: card.activity,
      assignee: card.assignee,
      messages: [
        { role: card.activityKind === "instruction" ? "user" : "assistant", text: card.activity, time: "최근" },
        { role: "assistant", text: "이 카드는 시안 흐름을 보여 주기 위한 대표 카드입니다.", time: "최근" },
      ],
    });
  };

  const closeOverlay = () => {
    setOverlay(null);
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
    {screen === "desk" ? <ApprovalDeskScreen docs={deskDocs} current={current}
      onSelect={setDeskId} onDispose={dispose} onUndo={undo} lastAction={lastAction}
      onOpenHome={() => navigate("home")} onOpenOverlay={openPending} /> : null}
    {screen === "home" || screen === "board" ? <HomePlannerScreen pending={pending}
      progress={progress} queue={QUEUE_CARDS} onHold={ON_HOLD_CARDS} completed={completed}
      referenceView={referenceView} boardView={screen === "board"}
      onToggleReference={toggleReference} onToggleBoard={() => navigate(screen === "board" ? "home" : "board")}
      onOpenDesk={() => navigate("desk")} onOpenPending={openPending} onOpenCard={openCard} /> : null}
    {screen === "pas" ? <PasBriefingScreen deskCount={deskDocs.length} onOpenDesk={() => navigate("desk")} /> : null}
    <CardSessionOverlay detail={overlay} onClose={closeOverlay} />
  </>;
}
