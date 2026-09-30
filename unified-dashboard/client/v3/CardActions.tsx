import { useState } from "react";
import { Button, DashboardIconCap, Dialog, DialogPopup, DialogHeader, DialogTitle, DialogFooter, Input } from "@seosoyoung/soul-ui";
import { Check, MessageCircle, Play, RotateCcw, X } from "lucide-react";
import type { CardRow, CardStatus } from "@seosoyoung/soul-ui/cards/card-types";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { V3ContextMenu, type V3ContextMenuTarget } from "./V3ContextMenu";

const states: readonly { status: CardStatus; label: string; separatorBefore?: boolean }[] = [
  { status: "todo", label: "할 일" },
  { status: "queued", label: "대기열" },
  { status: "running", label: "실행 중" },
  { status: "review", label: "검수" },
  { status: "done", label: "완료", separatorBefore: true },
  { status: "cancelled", label: "취소", separatorBefore: true },
];

export function CardActions({ card, onAnswer }: { card: CardRow; onAnswer(): void }) {
  return <CardStatusControl card={card} onAnswer={onAnswer} mode="actions" />;
}

export function CardStatusChip({ card }: { card: CardRow }) {
  return <CardStatusControl card={card} mode="chip" />;
}

function CardStatusControl({ card, mode, onAnswer }: {
  card: CardRow; mode: "chip" | "actions"; onAnswer?(): void;
}) {
  const [reject, setReject] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<V3ContextMenuTarget | null>(null);
  const reportCount = useCardStore(state => state.details[card.id]?.reports.length);
  const change = async (status: CardStatus, rejectionReason?: string) => {
    setPending(true);
    setError(null);
    try {
      await useCardStore.getState().mutate(card.id, "/status", {
        status, expectedVersion: card.version,
        ...(rejectionReason ? { reason: rejectionReason } : {}),
      });
      setReject(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  };
  const selectStatus = (status: CardStatus) => {
    if (card.status === "review" && status === "running") {
      setReason("");
      setReject(true);
    } else {
      void change(status);
    }
  };
  const action = (label: string, Icon: typeof Check, onClick: () => void) => (
    <DashboardIconCap key={label} label={label} disabled={pending} onClick={onClick}>
      <Icon className="h-4 w-4" aria-hidden="true" />
    </DashboardIconCap>
  );
  const labels = {
    todo: "할 일", queued: "대기",
    blocked: card.blockedKind === "question" ? "질문" : card.blockedKind === "limit" ? "한도 대기" : "막힘",
    running: "실행 중", review: "검수", done: "완료", cancelled: "취소",
  };
  const feedback = <>
    {error ? <span className="v3-card-error" role="alert">{error}</span> : null}
    <Dialog open={reject} onOpenChange={setReject}>
      <DialogPopup>
        <DialogHeader><DialogTitle>반려 사유</DialogTitle></DialogHeader>
        <Input aria-label="반려 사유" value={reason} onChange={event => setReason(event.target.value)} />
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => setReject(false)}>취소</Button>
          <Button disabled={pending || !reason.trim()} onClick={() => void change("running", reason.trim())}>반려</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  </>;
  if (mode === "chip") return <>
    <button type="button" className={`v3-status-chip v3-card-status-control v3-card-status--${card.status}`}
      aria-label="카드 상태 변경" aria-haspopup="menu" aria-expanded={menu !== null} disabled={pending}
      onClick={event => {
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        setMenu({ x: rect.left, y: rect.bottom });
        setError(null);
        if (reportCount === undefined) {
          void useCardStore.getState().loadCard(card.id).catch(error => {
            setError(error instanceof Error ? error.message : String(error));
          });
        }
      }}>
      {labels[card.status]}
    </button>
    <V3ContextMenu target={menu} onClose={() => setMenu(null)} actions={states.map(({ status, label, separatorBefore }) => ({
      label: status === card.status ? `${label} (현재)`
        : status === "review" && !reportCount ? "검수 (보고 필요)" : label,
      disabled: pending || status === card.status || (status === "review" && !reportCount),
      separatorBefore,
      onSelect: () => selectStatus(status),
    }))} />
    {feedback}
  </>;
  return <div className="v3-card-actions">
    {card.status === "review" ? <>
      {action("완료", Check, () => void change("done"))}
      {action("반려", RotateCcw, () => selectStatus("running"))}
    </> : null}
    {card.status === "blocked" ? card.blockedKind === "question"
      ? action("답하기", MessageCircle, () => onAnswer?.())
      : action("대기열로", Play, () => void change("queued")) : null}
    {card.status === "todo" ? action("맡기기", Play, () => void change("queued")) : null}
    {card.status === "queued" ? action("대기열에서 빼기", X, () => void change("todo")) : null}
    {feedback}
  </div>;
}
