import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { SessionSummary } from "@seosoyoung/soul-ui";
import { createPageApiClient } from "@seosoyoung/soul-ui/page";

import { createPlannerDataDependencies } from "./planner-data";
import { BrowserRitualActionPort } from "./ritual-browser-port";
import { loadMorningRitualData, type MorningRitualData } from "./ritual-data";
import {
  dispatchRitualAction,
  type RitualAction,
  type RitualQueueItem,
} from "./ritual-model";
import "./ritual.css";

type RitualLoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: MorningRitualData }
  | { status: "error"; message: string };

export function RitualModal({
  open,
  today,
  sessions,
  onClose,
  onRefresh,
}: {
  open: boolean;
  today: string;
  sessions: readonly SessionSummary[];
  onClose(): void;
  onRefresh(): void;
}) {
  const api = useMemo(() => createPageApiClient(), []);
  const plannerDependencies = useMemo(() => createPlannerDataDependencies(), []);
  const [loadState, setLoadState] = useState<RitualLoadState>({ status: "idle" });
  const [index, setIndex] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [chatDestination, setChatDestination] = useState<string | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open || loadState.status !== "idle") return;
    setLoadState({ status: "loading" });
    void loadMorningRitualData({
      api,
      today,
      sessions,
      plannerDependencies,
    }).then((data) => {
      setLoadState({ status: "ready", data });
    }).catch((error: unknown) => {
      setLoadState({ status: "error", message: errorText(error) });
    });
  }, [api, loadState.status, open, plannerDependencies, sessions, today]);

  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [open]);

  if (!open) return null;

  const data = loadState.status === "ready" ? loadState.data : null;
  const item = data?.items[index] ?? null;
  const complete = data !== null && index >= data.items.length;
  const progress = data
    ? (data.items.length === 0 ? 100 : Math.round((index / data.items.length) * 100))
    : 0;

  const handleAction = async (action: RitualAction) => {
    if (!data || !item || processing) return;
    setProcessing(true);
    setActionError(null);
    try {
      const result = await dispatchRitualAction(
        item,
        action,
        new BrowserRitualActionPort(data.dailyPageId, api),
      );
      if (result.openSessionId) setChatDestination(result.openSessionId);
      setIndex((value) => value + 1);
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setProcessing(false);
    }
  };

  const finish = () => {
    const destination = chatDestination;
    onRefresh();
    onClose();
    setLoadState({ status: "idle" });
    setIndex(0);
    setActionError(null);
    setChatDestination(null);
    if (destination) window.location.assign(`/#${encodeURIComponent(destination)}`);
  };

  return (
    <div className="v3-ritual-overlay" role="dialog" aria-modal="true" aria-labelledby="v3-ritual-title">
      <section className="v3-ritual-modal">
        <header className="v3-ritual-head">
          <span className="v3-ritual-icon v3-emoji" aria-hidden="true">☀️</span>
          <div>
            <h2 id="v3-ritual-title">어제에서 넘어온 것</h2>
            <p>하나씩 결정하면 오늘 플래너가 가벼워집니다.</p>
          </div>
          <button ref={closeButton} type="button" aria-label="아침 정리 닫기" onClick={onClose}>×</button>
        </header>
        <div className="v3-ritual-body">
          {loadState.status === "loading" ? <RitualMessage text="이월할 항목을 모으는 중…" /> : null}
          {loadState.status === "error" ? (
            <RitualMessage text={`아침 정리를 불러오지 못했습니다 · ${loadState.message}`}>
              <button type="button" className="v3-button v3-button--primary" onClick={() => setLoadState({ status: "idle" })}>다시 시도</button>
            </RitualMessage>
          ) : null}
          {data ? (
            <>
              <div className="v3-ritual-progress-row">
                <div className="v3-ritual-progress" role="progressbar" aria-label="아침 정리 진행률" aria-valuemin={0} aria-valuemax={100} aria-valuenow={complete ? 100 : progress}>
                  <span style={{ width: `${complete ? 100 : progress}%` }} />
                </div>
                <strong>{complete ? `${data.items.length} / ${data.items.length}` : `${index + 1} / ${data.items.length}`}</strong>
              </div>
              {complete ? (
                <div className="v3-ritual-done">
                  <span aria-hidden="true">✓</span>
                  <h3>오늘 준비 완료</h3>
                  <p>결정한 업무와 검수 항목을 오늘 플래너에 반영했습니다.</p>
                  <button type="button" className="v3-button v3-button--primary" onClick={finish}>
                    {chatDestination ? "선택한 채팅 열기" : "플래너 열기"}
                  </button>
                </div>
              ) : item ? (
                <RitualItemCard
                  item={item}
                  processing={processing}
                  error={actionError}
                  onAction={(action) => { void handleAction(action); }}
                />
              ) : null}
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function RitualItemCard({
  item,
  processing,
  error,
  onAction,
}: {
  item: RitualQueueItem;
  processing: boolean;
  error: string | null;
  onAction(action: RitualAction): void;
}) {
  return (
    <>
      <article className="v3-ritual-card">
        <span>{item.kind === "task" ? "미완 업무" : "검수 대기 세션"}</span>
        <h3>{item.title}</h3>
        <p>{item.description}</p>
        <small>◉ {item.agentLabel}</small>
      </article>
      {error ? <p className="v3-ritual-error" role="alert">{error}</p> : null}
      <div className="v3-ritual-actions">
        {item.kind === "task" ? (
          <>
            <button type="button" disabled={processing} className="v3-button v3-button--primary" onClick={() => onAction("today")}>오늘로</button>
            <button type="button" disabled={processing} className="v3-button v3-button--ghost" onClick={() => onAction("later")}>미루기</button>
            <button type="button" disabled={processing} className="v3-button v3-button--soft" onClick={() => onAction("done")}>완료 처리</button>
          </>
        ) : (
          <>
            <button type="button" disabled={processing} className="v3-button v3-button--primary" onClick={() => onAction("chat")}>채팅 열기</button>
            <button type="button" disabled={processing} className="v3-button v3-button--soft" onClick={() => onAction("acknowledge")}>확인 처리</button>
            <button type="button" disabled={processing} className="v3-button v3-button--ghost" onClick={() => onAction("later")}>미루기</button>
          </>
        )}
      </div>
    </>
  );
}

function RitualMessage({ text, children }: { text: string; children?: React.ReactNode }) {
  return <div className="v3-ritual-message"><p>{text}</p>{children}</div>;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
