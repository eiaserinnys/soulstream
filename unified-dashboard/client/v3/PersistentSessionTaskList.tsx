import type { CardDetail, CardQuestion, CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { Button, DisclosureActionIcon } from "@seosoyoung/soul-ui";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { Tooltip } from "@base-ui/react/tooltip";
import { useEffect, useState, type CSSProperties, type ReactElement, type RefObject } from "react";
import { cardStatusLabel } from "./CardActions";
import { CardRow as CardRowComponent } from "./CardRow";
import { PersistentTaskTooltipPanel } from "./PersistentTaskTooltipPanel";
import { useCardMembership } from "./use-card-membership";
import { V3_CARD_GAP_PX } from "./v3-layout-metrics";
import "./v3-persistent-task-list.css";

const TASK_STATUSES = ["running", "blocked", "review", "queued", "todo"] as const;
type TaskStatus = typeof TASK_STATUSES[number];
const TASK_GROUPS_STORAGE_KEY = "soulstream:pas-task-groups:v1";
export interface PersistentSessionTaskGroup { status: TaskStatus; label: string; cards: CardRow[] }
export interface PersistentTaskTooltipContent { title?: string; now?: string; ask?: string }

export function persistentTaskTooltipContent(card: CardRow, titleTruncated: boolean, question?: CardQuestion | null): PersistentTaskTooltipContent | null {
  const content: PersistentTaskTooltipContent = {};
  if (titleTruncated) content.title = card.title;
  if (card.now?.text.trim()) content.now = card.now.text;
  if (question?.text.trim()) content.ask = question.text;
  else if (!question && card.now?.turn === "user" && card.now.ask?.trim()) content.ask = card.now.ask;
  return Object.keys(content).length ? content : null;
}

export function latestUnansweredTooltipQuestion(detail: CardDetail | undefined): CardQuestion | null {
  return detail?.questions.reduce<CardQuestion | null>((latest, question) => {
    if (question.answer !== null || question.withdrawnAt) return latest;
    return latest === null || question.askedAt > latest.askedAt ? question : latest;
  }, null) ?? null;
}

const TOOLTIP_MEDIA_QUERY = "(hover: hover) and (pointer: fine) and (min-width: 768px)";

export function isQuestionTooltipCard(card: CardRow): boolean {
  return card.status === "blocked" && card.blockedKind === "question";
}

function usePersistentTaskTooltips() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const media = window.matchMedia(TOOLTIP_MEDIA_QUERY);
    const update = () => setEnabled(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return enabled;
}

function PersistentTaskTooltip({ card, row, titleRef }: {
  card: CardRow; row: ReactElement; titleRef: RefObject<HTMLSpanElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const [titleTruncated, setTitleTruncated] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(false);
  const detail = useCardStore(state => state.details[card.id]);
  const currentDetail = detail?.card.version === card.version ? detail : undefined;
  const question = isQuestionTooltipCard(card)
    ? latestUnansweredTooltipQuestion(currentDetail)
    : null;
  const options = question?.options?.length ? question.options : [];
  const content = persistentTaskTooltipContent(card, titleTruncated, question);

  const loadQuestionDetail = () => {
    if (!isQuestionTooltipCard(card)) return;
    const current = useCardStore.getState().details[card.id];
    if (!current || current.card.version !== card.version) {
      void useCardStore.getState().loadCard(card.id).catch(() => undefined);
    }
  };

  const sendAnswer = async (answer: string) => {
    if (!question || sending) return;
    setSending(true);
    setSendError(false);
    try {
      await useCardStore.getState().mutate(card.id,
        `/questions/${encodeURIComponent(question.id)}/answer`, { answer });
      setOpen(false);
    } catch {
      setSendError(true);
    } finally {
      setSending(false);
    }
  };

  const root = <Tooltip.Root open={open} onOpenChange={nextOpen => {
    if (!nextOpen) {
      if (sending) return;
      setOpen(false);
      return;
    }
    const title = titleRef.current;
    const nextTitleTruncated = Boolean(title && title.scrollWidth > title.clientWidth);
    const hasQuestionContent = card.status === "blocked" && card.blockedKind === "question";
    if (!persistentTaskTooltipContent(card, nextTitleTruncated, question) && !hasQuestionContent) {
      setOpen(false);
      return;
    }
    setTitleTruncated(nextTitleTruncated);
    setOpen(true);
  }}>
    <Tooltip.Trigger render={row} onPointerEnter={loadQuestionDetail} onFocus={loadQuestionDetail}/>
    {content || options.length > 0 ? <Tooltip.Portal>
      <Tooltip.Positioner side="left" align="start" sideOffset={8} alignOffset={-1}
        collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
        className="v3-persistent-task-tooltip"
        style={{ "--v3-card-gap": `${V3_CARD_GAP_PX}px` } as CSSProperties}>
        <Tooltip.Popup className="v3-surface">
          <PersistentTaskTooltipPanel content={content ?? {}} options={options} sending={sending} error={sendError} onSelect={sendAnswer}/>
        </Tooltip.Popup>
      </Tooltip.Positioner>
    </Tooltip.Portal> : null}
  </Tooltip.Root>;
  return isQuestionTooltipCard(card) ? <Tooltip.Provider delay={300}>{root}</Tooltip.Provider> : root;
}

function readCollapsedTaskGroups(): TaskStatus[] {
  if (typeof window === "undefined") return ["todo"];
  try {
    const raw = window.localStorage.getItem(TASK_GROUPS_STORAGE_KEY);
    if (raw === null) return ["todo"];
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || !Array.isArray((value as { collapsed?: unknown }).collapsed)) return ["todo"];
    const collapsed = (value as { collapsed: unknown[] }).collapsed;
    if (!collapsed.every(status => TASK_STATUSES.includes(status as TaskStatus))) return ["todo"];
    return [...new Set(collapsed as TaskStatus[])];
  } catch {
    return ["todo"];
  }
}

/** Applies the whole-board status order and position ordering to shared card membership. */
export function groupPersistentSessionTasks(cards: readonly CardRow[]): PersistentSessionTaskGroup[] {
  return TASK_STATUSES.flatMap(status => {
    const matching = cards.filter(card => card.status === status).sort((left, right) => {
      const leftKey = status === "queued" ? left.queuePositionKey ?? "" : left.positionKey;
      const rightKey = status === "queued" ? right.queuePositionKey ?? "" : right.positionKey;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    if (matching.length === 0) return [];
    return [{ status, label: cardStatusLabel({ ...matching[0], blockedKind: null }), cards: matching }];
  });
}

export function PersistentSessionTaskList({cards,onOpenCard}: {
  cards?: readonly CardRow[]; onOpenCard(cardId: string): void;
}) {
  if (cards !== undefined) return <TaskListContent cards={cards} onOpenCard={onOpenCard}/>;
  return <ConnectedTaskList onOpenCard={onOpenCard}/>;
}

function ConnectedTaskList({onOpenCard}:{onOpenCard(cardId:string):void}) {
  const membership = useCardMembership(undefined);
  return <TaskListContent cards={membership.cards} loading={membership.loading} error={membership.error} retry={membership.retry} onOpenCard={onOpenCard}/>;
}

function TaskListContent({cards,loading,error,retry,onOpenCard}: {
  cards: readonly CardRow[]; loading?: boolean; error?: string | null; retry?:()=>void; onOpenCard(cardId:string):void;
}) {
  const [collapsedGroups,setCollapsedGroups]=useState(readCollapsedTaskGroups);
  const tooltipsEnabled = usePersistentTaskTooltips();
  useEffect(()=>{
    try { window.localStorage.setItem(TASK_GROUPS_STORAGE_KEY,JSON.stringify({collapsed:collapsedGroups})); }
    catch { /* Keep the task list usable when storage is unavailable. */ }
  },[collapsedGroups]);
  const groups = groupPersistentSessionTasks(cards);
  const numberedCards=groups.flatMap(group=>group.cards).filter(card=>card.number!==undefined&&card.number!==null);
  const widestNumber=numberedCards.reduce<number|null>((widest,card)=>widest===null||String(card.number).length>String(widest).length?card.number!:widest,null);
  const summaryNumberTemplate=widestNumber===null?undefined:`#${widestNumber}`;
  return <Tooltip.Provider delay={300}><div className="v3-persistent-task-list" data-testid="persistent-session-task-list" aria-busy={loading&&!error||undefined}>
    {error?<div className="v3-persistent-task-list-error" role="alert"><span className="v3-card-error">작업 목록을 불러오지 못했습니다.</span>{retry?<Button size="sm" variant="outline" className="v3-persistent-task-paper-button" onClick={retry}>다시 시도</Button>:null}</div>:null}
    {!error&&loading?<p className="v3-card-board-empty" role="status">불러오는 중…</p>:null}
    {!error&&!loading&&groups.length===0?<p className="v3-card-board-empty">카드가 없습니다.</p>:null}
    {!error?groups.map(group=>{
      const expanded=!collapsedGroups.includes(group.status);
      return <section key={group.status} data-task-status-group={group.status} aria-label={group.label}>
        <div className="v3-detail-section-head v3-persistent-task-group-label"><h3>
          <button type="button" className="v3-persistent-task-group-toggle outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-expanded={expanded} onClick={()=>setCollapsedGroups(current=>expanded?[...current,group.status]:current.filter(status=>status!==group.status))}>
            <span className="v3-persistent-task-group-name">{group.label}</span>
            <span className="v3-persistent-task-group-count">{group.cards.length}개</span>
            <DisclosureActionIcon expanded={expanded} className="h-4 w-4"/>
          </button>
        </h3></div>
        {expanded?<div className="v3-run-list">{group.cards.map(card=><CardRowComponent key={card.id} card={card} variant="summary" summaryNumberTemplate={summaryNumberTemplate} onOpenCard={onOpenCard}
          summaryRowWrapper={tooltipsEnabled ? (row,titleRef)=><PersistentTaskTooltip card={card} row={row} titleRef={titleRef}/> : undefined}/>)}</div>:null}
      </section>;
    }):null}
  </div></Tooltip.Provider>;
}
