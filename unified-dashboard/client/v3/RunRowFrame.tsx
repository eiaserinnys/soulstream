import type { HTMLAttributes, ReactNode } from "react";
import { LiquidGlassCard } from "@seosoyoung/soul-ui/components/LiquidGlassCard";
import "./v3-run-history.css";

/** Shared markup and dimensions for session and card rows. */
export function RunRowFrame({avatar,title,agentLine,affiliation,preview,trailing,actions,handle,openLabel,onOpen,disabled,size="default",className="",interactiveTrailing=false,...props}: Omit<HTMLAttributes<HTMLDivElement>,"title"> & {
 avatar:ReactNode;title:ReactNode;agentLine:ReactNode;affiliation?:ReactNode;preview?:string;trailing:ReactNode;
 actions?:ReactNode;handle?:ReactNode;openLabel?:string;onOpen():void;disabled?:boolean;size?:"default"|"small";interactiveTrailing?:boolean;
}) {
 const content=<><span className="v3-run-avatar">{avatar}</span><span className="v3-run-copy">
  <span className="v3-run-identity"><span className="v3-run-title-line">{title}</span><span className="v3-run-agent-line">{agentLine}</span></span>
  {affiliation}{size!=="small"?<small>{preview}</small>:null}
 </span><span className="v3-run-trailing">{trailing}</span></>;
 return <LiquidGlassCard webglSurface cornerRadius={14} className={`v3-run-row${size==="small"?" v3-run-row--small":""}${className?` ${className}`:""}`} {...props}>
  {handle}{interactiveTrailing ? <div className="v3-run-open outline-none focus-visible:ring-2 focus-visible:ring-ring" role="button" tabIndex={0} aria-label={openLabel} onClick={event=>{if(!(event.target as Element).closest("button"))onOpen();}} onKeyDown={event=>{if(event.target===event.currentTarget&&(event.key==="Enter"||event.key===" ")){event.preventDefault();onOpen();}}}>{content}</div> :
   <button type="button" className="v3-run-open" aria-label={openLabel} disabled={disabled} onClick={onOpen}>{content}</button>}
  {actions?<div className="v3-run-row-actions">{actions}</div>:null}
 </LiquidGlassCard>;
}
