import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { DashboardIconCap, DisclosureActionIcon } from "@seosoyoung/soul-ui";
import { LiquidGlassCard } from "@seosoyoung/soul-ui/components/LiquidGlassCard";
import { Check, ChevronRight, MoreHorizontal, Star } from "lucide-react";
import { StatusChip } from "./StatusChip";
import "./v3-run-history.css";

type ActionState = { label: string; onAction(event: MouseEvent<HTMLButtonElement>): void; disabled?: boolean; pending?: boolean };
/** Only actions used by operational rows; callers cannot choose their cap or layout. */
export type RunRowAction = ActionState & (
  | { kind: "open" | "complete" | "acknowledge" | "menu" }
  | { kind: "star"; pressed: boolean }
  | { kind: "disclosure"; expanded: boolean }
);
type RowStatus = { label: string; tone?: string };
export type RunRowFrameProps = {
  avatar: ReactNode; title: ReactNode; agentLine: ReactNode; affiliation?: ReactNode; preview?: string; cardSummary?:ReactNode;cardTurn?:ReactNode;
  status: RowStatus; timestamp?: { display: string; raw?: string }; secondaryStatus?: RowStatus;
  actions?: readonly RunRowAction[]; handle?: ReactNode;
  openLabel?: string; onOpen(): void; disabled?: boolean; size?: "default" | "small";
  variant?: "session" | "card" | "folder"; active?: boolean; failed?: boolean; offline?: boolean;
  sessionId?: string; cardId?: string; blockedKind?: string | null; testId?: string;
  onContextMenu?(event: MouseEvent<HTMLDivElement>): void;
};

/** Sole owner of row inset, tracks, right information and small actions. */
export function RunRowFrame({avatar,title,agentLine,affiliation,preview,cardSummary,cardTurn,status,timestamp,secondaryStatus,actions,handle,
  openLabel,onOpen,disabled,size="default",variant="session",active,failed,offline,sessionId,cardId,blockedKind,testId,onContextMenu}: RunRowFrameProps) {
  const hasPreview=size!=="small"&&Boolean(preview);
  const hasActions=Boolean(actions?.length);
  const lines=1+(agentLine?1:0)+(hasPreview?1:0)+(affiliation?1:0)+(cardSummary?1:0)+(cardTurn?1:0);
  const content=<><span className="v3-run-avatar">{avatar}</span><span className="v3-run-copy">
    <span className="v3-run-identity"><span className="v3-run-title-line">{title}</span>{agentLine?<span className="v3-run-agent-line">{agentLine}</span>:null}</span>
    {affiliation}{hasPreview?<small>{preview}</small>:null}
    {cardSummary?<span className="v3-run-card-summary">{cardSummary}</span>:null}
    {cardTurn?<span className="v3-run-card-turn" title={typeof cardTurn==="string"?cardTurn:undefined}>{cardTurn}</span>:null}
  </span><span className="v3-run-trailing">
    <StatusChip label={status.label} tone={status.tone}/>
    {timestamp?<time dateTime={timestamp.raw}>{timestamp.display}</time>:null}
    {secondaryStatus?<StatusChip label={secondaryStatus.label} tone={secondaryStatus.tone} className="v3-run-secondary-status"/>:null}
  </span>{hasActions?<span className="v3-run-row-actions">{actions!.map(action=><DashboardIconCap key={action.kind} size="small"
      label={action.label} disabled={disabled||action.disabled||action.pending}
      aria-pressed={action.kind==="star"?action.pressed:undefined} aria-expanded={action.kind==="disclosure"?action.expanded:undefined}
      onClick={event=>{event.stopPropagation();action.onAction(event);}}>
      <RowActionIcon action={action}/>
    </DashboardIconCap>)}</span>:null}
  </>;
  return <LiquidGlassCard webglSurface cornerRadius={14}
    style={{"--v3-run-text-lines":lines} as CSSProperties}
    className={`v3-run-row${size==="small"?" v3-run-row--small":""}${variant==="card"?" v3-card-row":variant==="folder"?" v3-task-card":""}${active?" is-active":""}${failed?" v3-run-row--failed":""}${offline?" v3-run-row--offline":""}`}
    data-has-actions={hasActions || undefined} data-has-agent={Boolean(agentLine) || undefined} data-row-variant={variant} data-row-state={status.tone} data-row-lines={lines} data-load-state={failed?"failed":"ready"}
    data-session-id={sessionId} data-card-id={cardId} data-blocked-kind={blockedKind} data-testid={testId} onContextMenu={onContextMenu}>
    {handle}{hasActions?<div className="v3-run-open outline-none focus-visible:ring-2 focus-visible:ring-ring" role="button"
      tabIndex={disabled?-1:0} aria-disabled={disabled||undefined} aria-label={openLabel}
      onClick={event=>{if(!disabled&&!(event.target as Element).closest("button"))onOpen();}}
      onKeyDown={event=>{if(!disabled&&event.target===event.currentTarget&&(event.key==="Enter"||event.key===" ")){event.preventDefault();onOpen();}}}>{content}</div>:
      <button type="button" className="v3-run-open" aria-label={openLabel} disabled={disabled} onClick={onOpen}>{content}</button>}
  </LiquidGlassCard>;
}

function RowActionIcon({action}:{action:RunRowAction}) {
  switch(action.kind) {
    case "open": return <ChevronRight className="h-4 w-4" aria-hidden="true"/>;
    case "complete": case "acknowledge": return <Check className="h-4 w-4" aria-hidden="true"/>;
    case "menu": return <MoreHorizontal className="h-4 w-4" aria-hidden="true"/>;
    case "star": return <Star className="h-4 w-4" fill={action.pressed?"currentColor":"none"} aria-hidden="true"/>;
    case "disclosure": return <DisclosureActionIcon expanded={action.expanded} className="h-4 w-4"/>;
  }
}
