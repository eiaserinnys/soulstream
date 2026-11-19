import { useEffect, useRef, useState } from "react";
import { Button } from "@seosoyoung/soul-ui";
import { CalendarClock, Check, CornerDownRight, Archive, PencilLine } from "lucide-react";
import { GlassPanel } from "./GlassPanel";
import type { PendingDoc } from "./approval-desk-data";

export type DispositionKind = "supplement" | "snooze" | "reference" | "approve";

const SNOOZE_OPTIONS = ["내일 오전 9시", "3일 뒤", "다음 주 월요일"];

export function ApprovalDeskStampBar({ doc, onDispose, onQuestionAction }: {
  doc: PendingDoc;
  onDispose(doc: PendingDoc, kind: DispositionKind, detail?: string): void;
  onQuestionAction(kind: "different" | "ask"): void;
}) {
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSnoozeOpen(false);
  }, [doc.id]);

  useEffect(() => {
    if (!snoozeOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      if (triggerRef.current?.contains(event.target as Node)) return;
      setSnoozeOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [snoozeOpen]);

  const closeSnooze = () => {
    setSnoozeOpen(false);
    triggerRef.current?.focus();
  };
  const chooseSnooze = (option: string) => {
    setSnoozeOpen(false);
    onDispose(doc, "snooze", option);
  };

  return <GlassPanel as="div" webgl className="ad1707-stamp-bar" role="group" aria-label="결재 처분">
    <div className="ad1707-stamp-group">
      {doc.kind === "question" ? <>
        <Button variant="outline" size="lg" className="ad1707-stamp-button" onClick={() => onQuestionAction("different")}>
          <PencilLine className="size-4" aria-hidden="true" />다르게 답하기
        </Button>
        <Button variant="outline" size="lg" className="ad1707-stamp-button" onClick={() => onQuestionAction("ask")}>
          <CornerDownRight className="size-4" aria-hidden="true" />되묻기
        </Button>
      </> : <Button variant="outline" size="lg" className="ad1707-stamp-button" onClick={() => onDispose(doc, "supplement", "보완 지시")}>
        <PencilLine className="size-4" aria-hidden="true" />보완 지시
      </Button>}
    </div>

    <div className="ad1707-snooze">
      <Button ref={triggerRef} variant="outline" size="lg" className="ad1707-stamp-button"
        aria-haspopup="menu" aria-expanded={snoozeOpen}
        onClick={() => setSnoozeOpen(value => !value)}>
        <CalendarClock className="size-4" aria-hidden="true" />다시 보기
      </Button>
      {snoozeOpen ? <div ref={menuRef} className="ad1707-snooze-menu glass-strong glass-chrome lg-rim" role="menu"
        aria-label="다시 보기 시각" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); closeSnooze(); } }}>
        {SNOOZE_OPTIONS.map(option => <button key={option} type="button" role="menuitem" className="ad1707-snooze-item"
          onClick={() => chooseSnooze(option)}>{option}</button>)}
      </div> : null}
    </div>

    <Button variant="outline" size="lg" className="ad1707-stamp-button ad1707-stamp-reference"
      onClick={() => onDispose(doc, "reference")}>
      <Archive className="size-4" aria-hidden="true" />참고 갈무리
    </Button>

    <Button variant={doc.kind === "task" ? "success" : "default"} size="lg"
      className="ad1707-stamp-button ad1707-stamp-approve"
      disabled={doc.kind === "question"}
      title={doc.kind === "question" ? "선택지에서 답을 고르세요" : undefined}
      onClick={() => onDispose(doc, "approve")}>
      <Check className="size-4" aria-hidden="true" />{doc.kind === "task" ? "했어" : "승인 완료"}
    </Button>
  </GlassPanel>;
}
