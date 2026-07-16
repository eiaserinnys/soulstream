import {
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@seosoyoung/soul-ui";
import { createPageApiClient } from "@seosoyoung/soul-ui/page";

import { createPlannerDataDependencies } from "./planner-data";
import { BrowserRitualActionPort } from "./ritual-browser-port";
import { loadMorningRitualData, type MorningRitualData } from "./ritual-data";
import {
  dispatchRitualAction,
  type RitualAction,
  type RitualQueueItem,
} from "./ritual-model";
import { V3ErrorNotice } from "./V3ErrorNotice";
import "./ritual.css";

type RitualLoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: MorningRitualData }
  | { status: "error"; message: string };

export function RitualModal({
  open,
  today,
  reviewCount,
  onClose,
  onActionApplied,
  onOpenReviewQueue,
}: {
  open: boolean;
  today: string;
  reviewCount: number;
  onClose(): void;
  onActionApplied(item: RitualQueueItem, action: RitualAction): void;
  onOpenReviewQueue(): void;
}) {
  const api = useMemo(() => createPageApiClient(), []);
  const plannerDependencies = useMemo(() => createPlannerDataDependencies(), []);
  const [loadState, setLoadState] = useState<RitualLoadState>({ status: "idle" });
  const [index, setIndex] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || loadState.status !== "idle") return;
    setLoadState({ status: "loading" });
    void loadMorningRitualData({
      api,
      today,
      plannerDependencies,
    }).then((data) => {
      setLoadState({ status: "ready", data });
    }).catch((error: unknown) => {
      console.error("[v3/ritual] 아침 정리 조회 실패", error);
      setLoadState({ status: "error", message: errorText(error) });
    });
  }, [api, loadState.status, open, plannerDependencies, today]);

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
      await dispatchRitualAction(
        item,
        action,
        new BrowserRitualActionPort(data.dailyPageId, api),
      );
      onActionApplied(item, action);
      setIndex((value) => value + 1);
    } catch (error) {
      console.error("[v3/ritual] 이월 업무 변경 실패", error);
      setActionError(errorText(error));
    } finally {
      setProcessing(false);
    }
  };

  const finish = () => {
    onClose();
    setLoadState({ status: "idle" });
    setIndex(0);
    setActionError(null);
  };
  const openReviewQueue = () => {
    finish();
    onOpenReviewQueue();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogPopup
        className="v3-ritual-modal max-w-[520px]"
        closeProps={{ "aria-label": "아침 정리 닫기" }}
      >
        <DialogHeader className="v3-ritual-head">
          <span className="v3-ritual-icon v3-emoji" aria-hidden="true">☀️</span>
          <div>
            <DialogTitle>어제에서 넘어온 것</DialogTitle>
            <DialogDescription>하나씩 결정하면 오늘 플래너가 가벼워집니다.</DialogDescription>
          </div>
        </DialogHeader>
        <DialogPanel className="v3-ritual-body" scrollFade={false}>
          {loadState.status === "loading" ? <RitualMessage text="이월할 항목을 모으는 중…" /> : null}
          {loadState.status === "error" ? (
            <RitualMessage>
              <V3ErrorNotice message="아침 정리를 불러오지 못했습니다." detail={loadState.message}>
                <Button onClick={() => setLoadState({ status: "idle" })}>다시 시도</Button>
              </V3ErrorNotice>
            </RitualMessage>
          ) : null}
          {data ? (
            <>
              {complete ? (
                <div className="v3-ritual-done">
                  <span aria-hidden="true">✓</span>
                  <h3>오늘 준비 완료</h3>
                  <p>결정한 이월 업무를 오늘 플래너에 반영했습니다.</p>
                  {reviewCount > 0 ? (
                    <Button variant="link" className="v3-ritual-review-link" onClick={openReviewQueue}>
                      검수 대기 {reviewCount}건 → 검수 패널
                    </Button>
                  ) : null}
                </div>
              ) : item ? (
                <RitualItemCard
                  item={item}
                  error={actionError}
                />
              ) : null}
            </>
          ) : null}
        </DialogPanel>
        {data ? (
          <DialogFooter className="v3-ritual-footer">
            <div className="v3-ritual-progress-row">
              <div className="v3-ritual-progress" role="progressbar" aria-label="아침 정리 진행률" aria-valuemin={0} aria-valuemax={100} aria-valuenow={complete ? 100 : progress}>
                <span style={{ width: `${complete ? 100 : progress}%` }} />
              </div>
              <strong>{complete ? `${data.items.length} / ${data.items.length}` : `${index + 1} / ${data.items.length}`}</strong>
            </div>
            {complete ? (
              <Button className="v3-ritual-finish" onClick={finish}>
                플래너 열기
              </Button>
            ) : item ? (
              <RitualActions
                item={item}
                processing={processing}
                onAction={(action) => { void handleAction(action); }}
              />
            ) : null}
          </DialogFooter>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function RitualItemCard({
  item,
  error,
}: {
  item: RitualQueueItem;
  error: string | null;
}) {
  return (
    <>
      <article className="v3-ritual-card">
        <span>미완 업무</span>
        <h3>{item.title}</h3>
        <p>{item.description}</p>
        <small>◉ {item.agentLabel}</small>
      </article>
      {error ? <V3ErrorNotice className="v3-ritual-error" message="업무 상태를 바꾸지 못했습니다." detail={error} /> : null}
    </>
  );
}

function RitualActions({
  item,
  processing,
  onAction,
}: {
  item: RitualQueueItem;
  processing: boolean;
  onAction(action: RitualAction): void;
}) {
  return (
    <div className="v3-ritual-actions">
      <Button disabled={processing} onClick={() => onAction("today")}>오늘로</Button>
      <Button disabled={processing} variant="ghost" onClick={() => onAction("later")}>미루기</Button>
      <Button disabled={processing} variant="success" onClick={() => onAction("done")}>완료 처리</Button>
    </div>
  );
}

function RitualMessage({ text, children }: { text?: string; children?: React.ReactNode }) {
  return <div className="v3-ritual-message">{text ? <p>{text}</p> : null}{children}</div>;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
