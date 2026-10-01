import { useEffect, useRef, useState } from "react";
import { Button, Input, Popover, PopoverPopup, PopoverTrigger } from "@seosoyoung/soul-ui";
import type { CardDetail, CardRow, CardStatus } from "@seosoyoung/soul-ui/cards/card-types";
import { cardStatusLabel } from "./CardActions";
import { StatusChip } from "./StatusChip";
import "./v3-card-status-picker.css";

export interface CardStatusControl {
  pending: boolean;
  load(): Promise<CardDetail>;
  change(card: CardRow, status: CardStatus, reason?: string): Promise<unknown>;
}
const choices = ["todo", "queued", "running", "review", "done", "cancelled"] as const;

/** Common popover and menu buttons also host the required reason input step. */
export function CardStatusPicker({card, control, onOpen}: {card: CardRow; control: CardStatusControl; onOpen(): void}) {
  const [open, setOpen] = useState(false), [detail, setDetail] = useState<CardDetail | null>(null);
  const [loading, setLoading] = useState(false), [pending, setPending] = useState(false);
  const [error, setError] = useState(""), [reasonStep, setReasonStep] = useState(false), [draft, setDraft] = useState("");
  const generation = useRef(0), writing = useRef(false);
  useEffect(() => () => {generation.current++;}, [card.id]);
  const refresh = async () => {
    const request = ++generation.current;
    setDetail(null); setError(""); setLoading(true);
    try {
      const latest = await control.load();
      if (request !== generation.current) return;
      setDetail(latest);
      if (latest.card.status !== "review") setReasonStep(false);
    } catch (failure) {
      if (request === generation.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {if (request === generation.current) setLoading(false);}
  };
  const changeOpen = (next: boolean) => {
    if (next === open) return;
    setOpen(next);
    if (next) {setReasonStep(false); void refresh();}
    else {generation.current++; setDetail(null); setLoading(false);}
  };
  const unanswered = detail?.questions.some(question => question.answer === null) ?? false;
  const busy = pending || control.pending;
  const unavailable = !detail || loading || busy || Boolean(error) || unanswered;
  const change = async (status: CardStatus, reason?: string) => {
    if (unavailable || writing.current || !detail || status === detail.card.status) return;
    if (status === "review" && !detail.reports.length) return;
    if (status === "running" && detail.card.status === "review" && !reason?.trim()) {setReasonStep(true); return;}
    writing.current = true; setPending(true);
    const request = generation.current;
    try {
      await control.change(detail.card, status, reason);
      if (request === generation.current) {setDraft(""); changeOpen(false);}
    } catch (failure) {
      if (request === generation.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {writing.current = false; setPending(false);}
  };
  const tone = card.status === "blocked" && card.blockedKind === "question" ? "question" : card.status;
  return <Popover open={open} onOpenChange={changeOpen}>
    <PopoverTrigger className="v3-postit-status-trigger" aria-label="카드 상태 변경" disabled={control.pending}
      onClick={event => event.stopPropagation()}>
      <StatusChip label={cardStatusLabel(card)} tone={tone}/>
    </PopoverTrigger>
    <PopoverPopup align="end" className="v3-card-status-picker" data-card-status-picker onClick={event => event.stopPropagation()}>
      <div className="v3-card-status-picker-content">
        {loading ? <p role="status">불러오는 중…</p> : null}
        {error ? <><p role="alert">{error}</p><Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>{detail ? "갱신 후 재시도" : "다시 불러오기"}</Button></> : null}
        {unanswered ? <><p>질문에 답한 뒤 변경할 수 있습니다</p><Button size="sm" variant="ghost" onClick={() => {changeOpen(false); onOpen();}}>카드 상세 열기</Button></> : null}
        {reasonStep ? <form onSubmit={event => {event.preventDefault(); void change("running", draft.trim());}}>
          <Input aria-label="다시 실행할 사유" placeholder="다시 실행할 사유" value={draft} disabled={busy} onChange={event => setDraft(event.target.value)}/>
          <div className="v3-card-status-picker-actions">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setReasonStep(false)}>취소</Button>
            <Button size="sm" type="submit" disabled={unavailable || !draft.trim()}>확인</Button>
          </div>
        </form> : <div aria-label="카드 상태 목록">{choices.map(status => <Button key={status} variant="menu"
          aria-pressed={status === (detail?.card.status ?? card.status)} disabled={unavailable || status === "review" && !detail?.reports.length}
          onClick={() => void change(status)}>{cardStatusLabel({...card, status})}</Button>)}</div>}
        {!reasonStep && detail && !detail.reports.length ? <p>보고가 필요합니다</p> : null}
        {!reasonStep ? <p>대기: 담당 에이전트 실행이 시작될 수 있습니다</p> : null}
      </div>
    </PopoverPopup>
  </Popover>;
}
