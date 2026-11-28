import { useTranslation } from "react-i18next";
import { flushSync } from "react-dom";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Button, DashboardIconCap, Dialog, DialogPopup, DialogTitle, useDashboardStore, useIsMobile } from "@seosoyoung/soul-ui";
import { ExternalLink, PanelLeft, X } from "lucide-react";
import { StatusChip } from "../StatusChip";
import { PasCardPanelBoundary } from "./PasCardPanelBoundary";
import { PasThreadDecideBox } from "./PasThreadDecideBox";
import { PasThreadRail } from "./PasThreadRail";
import { PasThreadBody } from "./PasThreadTimeline";
import { AGENDA_KIND_LABEL } from "@seosoyoung/soul-ui/lib/pas-report-thread-core";
import type { ReportEntry } from "./pas-report-thread-model";
import { usePasReportThread, type PasReportThreadInput } from "./use-pas-report-thread";
import "./v3-pas-report-thread.css";

// 카드 패널(과 세션 칸 훅)은 대화 화면을 거쳐 이 창으로 되돌아오는 고리가 있어, 처음 열 때 불러온다.
const PasCardPanel = lazy(() => import("./PasCardPanel").then(module => ({ default: module.PasCardPanel })));
const DRAWER_QUERY = "(max-width: 819px)";
const KIND_TONE = { question: "question", request: "question", review: "review", blocked: "blocked", running: "running", verifying: "awaiting_verification" } as const;

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export interface PasReportThreadReportProps extends Omit<PasReportThreadInput, "entries"> {
  entries: readonly ReportEntry[];
  open: boolean;
  onClose(): void;
  /** 창을 연 말풍선 단추. 닫으면 초점이 여기로 돌아간다. */
  openTriggerRef: RefObject<HTMLElement | null>;
  /** 보고 창을 품은 PAS 자신의 세션. 카드의 담당 세션이 이것이면 PAS 화면의 대화를 그대로 쓴다. */
  ownSessionId?: string | null;
  /** false면(견본) 카드 패널의 세션 칸이 스트림을 열거나 세션을 조회하지 않는다. */
  liveSessions?: boolean;
}

// 보고 창 대화상자 말고 겹쳐 열린 팝업 층. 있으면 Esc는 가장 위의 그 층이 먼저 받는다.
const INNER_POPUPS = '[data-slot="popover-popup"], [data-slot="menu-popup"], [data-slot="select-popup"], [data-slot="alert-dialog-popup"]';
const innerLayerOpen = () => document.querySelector(INNER_POPUPS) !== null || document.querySelectorAll('[data-slot="dialog-popup"]').length > 1;
const activeRailItem = () => document.querySelector<HTMLElement>('.pas-rt-dialog .pas-rt-rail-item[data-active="true"]');

export function PasReportThreadReport({ open, onClose, openTriggerRef, ownSessionId = null, liveSessions = true, ...input }: PasReportThreadReportProps) {
  const drawerMode = useMediaQuery(DRAWER_QUERY);
  return <Dialog open={open} onOpenChange={next => { if (!next) onClose(); }}>
    <DialogPopup className="v3-surface pas-rt-dialog" showCloseButton={false} data-testid="pas-report-thread-dialog"
      initialFocus={() => (drawerMode ? document.querySelector<HTMLElement>('.pas-rt-dialog [data-testid="pas-rt-rail-toggle"]') : activeRailItem())}
      finalFocus={() => openTriggerRef.current?.isConnected ? openTriggerRef.current : null}>
      <PasReportThreadBody {...input} drawerMode={drawerMode} onClose={onClose} ownSessionId={ownSessionId} liveSessions={liveSessions} />
    </DialogPopup>
  </Dialog>;
}

function PasReportThreadBody({ drawerMode, onClose, ownSessionId, liveSessions, ...input }: Omit<PasReportThreadInput, "entries"> & { entries: readonly ReportEntry[]; drawerMode: boolean; onClose(): void; ownSessionId: string | null; liveSessions: boolean }) {
  const { t } = useTranslation();
  const controller = usePasReportThread(input);
  const { active, detail, loadState } = controller;
  const mobile = useIsMobile();
  const folders = useDashboardStore(state => state.catalog?.folders);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const railTrigger = useRef<HTMLButtonElement>(null);
  const panelTrigger = useRef<HTMLElement | null>(null);
  const undoButtonRef = useRef<HTMLButtonElement>(null);
  const autoRef = useRef(true);
  const [railOpen, setRailOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  // 카드 패널을 못 받아 실패 안내가 선 동안 보고 창의 나머지는 잠근다.
  const [panelFailed, setPanelFailed] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [hasNew, setHasNew] = useState(false);
  const drawerOpen = drawerMode && railOpen;

  const jump = useCallback(() => {
    const scroll = threadRef.current;
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
    autoRef.current = true;
    setAutoScroll(true);
    setHasNew(false);
  }, []);
  const keepLatest = useCallback(() => {
    const scroll = threadRef.current;
    if (scroll && autoRef.current) scroll.scrollTop = scroll.scrollHeight;
  }, []);
  // 처음과 안건을 바꿀 때, 카드 상세가 막 들어왔을 때 맨 아래에서 시작한다.
  const activeCardId = active?.cardId ?? null;
  useLayoutEffect(() => {
    jump();
    const frame = requestAnimationFrame(() => { if (autoRef.current) jump(); });
    return () => cancelAnimationFrame(frame);
  }, [activeCardId, loadState === "ready", jump]);
  // 새 경과: 맨 아래에 있으면 따라 내려가고, 위로 올려 둔 동안에는 알약에만 알린다.
  const activity = detail ? (detail.comments?.length ?? 0) + (detail.notes?.length ?? 0) + (detail.nowHistory?.length ?? 0)
    + (detail.statusHistory?.length ?? 0) + detail.questions.length + detail.sessions.length + detail.card.version : 0;
  const seen = useRef({ id: activeCardId, activity });
  useLayoutEffect(() => {
    const previous = seen.current;
    seen.current = { id: activeCardId, activity };
    if (previous.id !== activeCardId || activity === previous.activity || loadState !== "ready") return;
    if (autoRef.current) jump(); else setHasNew(true);
  }, [activeCardId, activity, loadState, jump]);
  // 대화상자 내용은 열린 뒤에 붙으므로 스레드가 붙는 순간 관찰을 건다. 경과가 늘거나 입력창이 펼쳐져
  // 스레드 높이가 줄어도 최신 경과 바닥을 지킨다.
  const attachThread = useCallback((node: HTMLDivElement | null) => {
    threadRef.current = node;
    if (!node) return;
    const observer = new ResizeObserver(() => { if (autoRef.current) node.scrollTop = node.scrollHeight; });
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    return () => { observer.disconnect(); threadRef.current = null; };
  }, []);

  const closeRail = useCallback(() => {
    // 숨기기 전에 초점을 옮겨야 대화상자가 초점을 창 머리로 되돌리지 않는다.
    railTrigger.current?.focus({ preventScroll: true });
    setRailOpen(false);
  }, []);
  const closePanel = useCallback(() => {
    // 패널이 사라지기 전에 초점을 연 단추로 옮긴다. 패널 안에서 초점이 사라지면 대화상자가 초점을 창 머리로 끌어간다.
    // inert가 남아 있으면 초점이 연 단추로 가지 못하므로 먼저 풀고 곧바로 그려 둔다.
    flushSync(() => setPanelFailed(false));
    panelTrigger.current?.focus({ preventScroll: true });
    setPanelOpen(false);
    requestAnimationFrame(() => panelTrigger.current?.focus({ preventScroll: true }));
  }, []);
  useEffect(() => { if (!drawerMode) setRailOpen(false); }, [drawerMode]);
  useEffect(() => {
    if (drawerOpen) requestAnimationFrame(() => activeRailItem()?.focus({ preventScroll: true }));
  }, [drawerOpen]);
  // 열린 것 하나씩 닫는다: 카드 패널, 서랍, 증거 확대(자체 대화상자), 보고 창 순.
  useEffect(() => {
    const closeInner = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 카드 패널 안 팝업(상태 고르기, 증거 확대 등)이 열려 있으면 그 Esc는 팝업 몫이다. 창이나 패널을 닫지 않는다.
      if (innerLayerOpen()) return;
      if (panelOpen) { event.preventDefault(); event.stopImmediatePropagation(); closePanel(); return; }
      if (railOpen && drawerMode) { event.preventDefault(); event.stopImmediatePropagation(); closeRail(); }
    };
    document.addEventListener("keydown", closeInner, true);
    return () => document.removeEventListener("keydown", closeInner, true);
  }, [panelOpen, railOpen, drawerMode, closePanel, closeRail]);

  // 처분 뒤 초점은 되돌리기 단추에, 없으면 지금 안건 행에 둔다. 누른 단추가 사라져도 초점이 떠돌지 않는다.
  const focusKey = `${controller.undo?.kind ?? ""}:${controller.undo?.cardId ?? ""}:${controller.processed.length}`;
  const firstFocusKey = useRef(focusKey);
  useEffect(() => {
    if (firstFocusKey.current === focusKey) return;
    firstFocusKey.current = focusKey;
    const frame = requestAnimationFrame(() => (undoButtonRef.current ?? (drawerMode ? railTrigger.current : activeRailItem()))?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [focusKey, drawerMode]);

  // 안건이 모두 사라져 패널이 내려가면 열림 표시도 함께 닫는다. 안건이 돌아와도 패널이 저절로 다시 뜨지 않는다.
  useEffect(() => {
    if (active || !panelOpen) return;
    setPanelOpen(false);
    setPanelFailed(false);
    // 연 단추는 안건이 없어 꺼져 있다. 패널이 사라지며 떨어진 초점을 빈 안내가 받는다.
    requestAnimationFrame(() => {
      const current = document.activeElement;
      if (!current || current === document.body) document.querySelector<HTMLElement>('.pas-rt-dialog [data-testid="pas-rt-empty"]')?.focus({ preventScroll: true });
    });
  }, [active, panelOpen]);
  const openPanel = (trigger: HTMLElement | null) => { panelTrigger.current = trigger; setPanelOpen(true); };
  return <>
    <header className="pas-rt-head" inert={panelFailed || undefined}>
      {drawerMode ? <div className="pas-rt-rail-toggle"><DashboardIconCap ref={railTrigger} size="small" appearance="bare" label={t("persistent.thread.agendas")}
        data-testid="pas-rt-rail-toggle" aria-expanded={railOpen} onClick={railOpen ? closeRail : () => setRailOpen(true)}>
        <PanelLeft className="size-5" strokeWidth={1.4} aria-hidden="true" /></DashboardIconCap></div> : null}
      <div className="pas-rt-heading">
        {active?.number != null ? <span className="pas-rt-number">#{active.number}</span> : null}
        <DialogTitle className="pas-rt-title">{active?.title || t("persistent.report.title")}</DialogTitle>
        {active ? <StatusChip label={AGENDA_KIND_LABEL[active.kind]} tone={KIND_TONE[active.kind]} /> : null}
      </div>
      <div className="pas-rt-tools">
        <DashboardIconCap size="small" appearance="bare" label={t("persistent.thread.openCardPanel")} data-testid="pas-rt-open-card-panel" disabled={!active}
          onClick={event => openPanel(event.currentTarget)}><ExternalLink className="size-5" strokeWidth={1.4} aria-hidden="true" /></DashboardIconCap>
        <DashboardIconCap size="small" appearance="bare" label={t("persistent.thread.closeReport")} onClick={onClose}><X className="size-5" strokeWidth={1.4} aria-hidden="true" /></DashboardIconCap>
      </div>
    </header>
    <div className="pas-rt-main" data-rail-open={drawerOpen || undefined} inert={panelFailed || undefined}>
      {drawerOpen ? <button type="button" tabIndex={-1} className="pas-rt-rail-scrim" aria-label={t("persistent.thread.closeAgenda")} onClick={closeRail} /> : null}
      <PasThreadRail controller={{ ...controller, select: id => { controller.select(id); if (drawerMode) closeRail(); } }} />
      <div className="pas-rt-thread" inert={drawerOpen ? true : undefined}>
        <div className="pas-rt-thread-content">
          <div ref={attachThread} tabIndex={-1} className="pas-rt-thread-scroll v3-session-panel-scroll" data-auto-scroll={autoScroll} data-testid="pas-rt-thread-scroll"
            onScroll={event => {
              const node = event.currentTarget;
              const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= 24;
              autoRef.current = atBottom; setAutoScroll(atBottom); if (atBottom) setHasNew(false);
            }}>
            <div>{active ? <PasThreadBody controller={controller} agenda={active} />
              : <p className="pas-rt-empty" data-testid="pas-rt-empty" tabIndex={-1}>{t("persistent.thread.noDecisions")}</p>}</div>
          </div>
          {!autoScroll ? <Button className="pas-rt-jump" data-testid="pas-rt-jump-latest" data-new={hasNew || undefined}
            onClick={() => { jump(); threadRef.current?.focus({ preventScroll: true }); }}>{t("persistent.thread.latest")}</Button> : null}
        </div>
        <PasThreadDecideBox controller={controller} agenda={active} undoButtonRef={undoButtonRef} onLayoutChange={keepLatest} />
      </div>
    </div>
    {panelOpen && active ? <PasCardPanelBoundary t={t} onClose={closePanel} onFailed={() => setPanelFailed(true)}><Suspense fallback={null}><PasCardPanel cardId={active.cardId} folders={folders ?? []} ownSessionId={ownSessionId}
      liveSessions={liveSessions} mobile={mobile} onClose={closePanel} /></Suspense></PasCardPanelBoundary> : null}
  </>;
}
