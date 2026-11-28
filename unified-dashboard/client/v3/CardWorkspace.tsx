import { useTranslation } from "react-i18next";
import { useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { SessionFilesPane } from "./SessionFilesPanel";
import { useSessionFilesToggle } from "./use-session-files-toggle";
import { CardDetailPane } from "./CardDetailPane";
import { WorkspaceSessionColumn } from "./WorkspaceSessionColumn";
import { DragHandle } from "@seosoyoung/soul-ui";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { cardWorkspaceLayout, cardWorkspaceLayoutForKey, resizeCardWorkspace, type CardWorkspaceLayout } from "./card-workspace-layout";
import { readV3CardWorkspaceLayout, writeV3CardWorkspaceLayout } from "./v3-session-panel-width";
import { V3_PANEL_GAP_PX } from "./v3-layout-metrics";

/** Card overlay uses the folder workspace's panel, split and mobile classes. */
export function CardWorkspace({cardId,folders,onClose,onCloseChat,onOpenSession,mobileMode,mobileTab,initialSessionId,sampleDetail,sampleExecution,onSampleChange,...chat}: {
 cardId:string;folders:ComponentProps<typeof CardDetailPane>["folders"];onClose():void;onCloseChat?():void;
 onOpenSession:ComponentProps<typeof CardDetailPane>["onOpenSession"];mobileMode:boolean;mobileTab:string;
 initialSessionId?:ComponentProps<typeof CardDetailPane>["initialSessionId"];
 sampleExecution?:ComponentProps<typeof CardDetailPane>["sampleExecution"];
 sampleDetail?:ComponentProps<typeof CardDetailPane>["sampleDetail"];
 onSampleChange?:ComponentProps<typeof CardDetailPane>["onSampleChange"];
} & Omit<ComponentProps<typeof WorkspaceSessionColumn>,"chatClassName"|"chatTestId"|"resizeClassName"|"resizeTestId"|"onResize"|"onResizeKeyDown"|"cardSessionCount">) {
 const {t}=useTranslation();
 const files=useSessionFilesToggle();
 const storedDetail=useCardStore(s=>s.details[cardId]);
 const cardDetail=sampleDetail??storedDetail;
 const cardSessionCount=cardDetail?new Set([initialSessionId,cardDetail.card.assigneeSessionId,...cardDetail.sessions.map(session=>session.sessionId)].filter(Boolean)).size:undefined;
 const workspace=useRef<HTMLDivElement>(null);
 const workspaceWidthRef=useRef(0);
 const [workspaceWidth,setWorkspaceWidth]=useState(0);
 const [layout,setLayout]=useState<CardWorkspaceLayout|null>(readV3CardWorkspaceLayout);
 const [host,setHost]=useState<Element|null>(null);
 useLayoutEffect(()=>{
  const focus=document.activeElement as HTMLElement|null;
  // Mount after the board portal in the same shell and existing overlay layer.
  setHost(workspace.current?.closest('.v3-shell')??null);
  return ()=>{if(focus?.isConnected)focus.focus({preventScroll:true});};
 },[]);
 useLayoutEffect(()=>{workspace.current?.querySelector<HTMLButtonElement>("[data-card-close]")?.focus({preventScroll:true});},[host]);
 useLayoutEffect(()=>{
  const element=workspace.current;
  if(!element||typeof ResizeObserver==="undefined")return;
  const measure=()=>{
   const next=element.getBoundingClientRect().width;
   workspaceWidthRef.current=next;
   setWorkspaceWidth(next);
  };
  measure();
  const observer=new ResizeObserver(measure);
  observer.observe(element);
  return ()=>observer.disconnect();
 },[host]);
 const resolved=cardWorkspaceLayout(workspaceWidth,layout);
 const update=(next:CardWorkspaceLayout|null)=>{setLayout(next);writeV3CardWorkspaceLayout(next);};
 const drag=(delta:number,edge:"left"|"middle")=>{
  const width=workspaceWidthRef.current;
  if(width>0){const next=resizeCardWorkspace(width,layout,delta*document.documentElement.clientWidth/100,edge);if(next!==undefined)update(next);}
 };
 const key=(event:import("react").KeyboardEvent<HTMLDivElement>,edge:"left"|"middle")=>{
  if(!["Home","ArrowLeft","ArrowRight"].includes(event.key))return;
  event.preventDefault();
  const next=cardWorkspaceLayoutForKey(workspaceWidthRef.current,layout,event.key,edge);
  if(next!==undefined)update(next);
 };
 const panes=<>
  <div className={files.open && chat.activeSession ? "v3-files-detail-hidden" : "v3-files-detail-visible"}><CardDetailPane cardId={cardId} folders={folders} onClose={onClose} onOpenSession={onOpenSession} initialSessionId={initialSessionId} sampleDetail={sampleDetail} sampleExecution={sampleExecution} onSampleChange={onSampleChange}/></div>
  {files.open && chat.activeSession && <SessionFilesPane sessionId={chat.activeSession.agentSessionId} storeScope={chat.storeScope} onClose={files.close} scrollTop={files.readScroll(chat.activeSession.agentSessionId)} onScroll={position=>files.saveScroll(chat.activeSession!.agentSessionId,position)} initiallyExpanded={files.readExpanded(chat.activeSession.agentSessionId)} onExpandedChange={value=>files.saveExpanded(chat.activeSession!.agentSessionId,value)} initiallySessionOpen={files.readSection(chat.activeSession!.agentSessionId, "session")} initiallyOtherOpen={files.readSection(chat.activeSession!.agentSessionId, "other")} onSectionChange={(section,value)=>files.saveSection(chat.activeSession!.agentSessionId,section,value)}/>}
  <WorkspaceSessionColumn cardSessionCount={cardSessionCount} filesOpen={files.open} onToggleFiles={files.toggle} {...chat} onClose={mobileMode?onCloseChat:undefined} chatClassName="" chatTestId="v3-card-session-chat" resizeClassName="v3-workspace-divider" resizeTestId="v3-card-workspace-divider" onResize={delta=>drag(delta,"middle")} onResizeKeyDown={event=>key(event,"middle")}
   separatorAria={{"aria-valuenow":resolved.cardWidth,"aria-valuemin":resolved.minimum,"aria-valuemax":resolved.totalWidth-resolved.gap-resolved.minimum,"aria-valuetext":t("cards.splitWidths", {card:Math.round(resolved.cardWidth),chat:Math.round(resolved.chatWidth)})}}/>
 </>;
 const content=<div className="v3-workspace-scrim is-chat-open" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}
  onKeyDown={event=>{
   if(event.defaultPrevented)return;
   if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();}
   if(event.key==='Tab'){
    const nodes=[...workspace.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter(node=>node.getClientRects().length);
    const first=nodes[0],last=nodes.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
   }
  }}>
  <div ref={workspace} className="v3-workspace is-chat-open" data-testid="v3-card-workspace" data-placement="overlay" data-mobile-view={mobileMode?mobileTab:undefined} data-mobile-files={mobileMode && mobileTab === "chat" && files.open ? "true" : undefined} onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}
   data-card-width-px={Math.round(resolved.cardWidth)} data-pair-width-px={Math.round(resolved.totalWidth)}>
   <div className="v3-card-workspace-pair" style={mobileMode?{display:"contents"}:workspaceWidth>0?{width:resolved.totalWidth,gridTemplateColumns:`${resolved.cardWidth}px ${resolved.gap}px minmax(0,1fr)`}:undefined}>
    <div className="v3-workspace-divider v3-card-workspace-left-divider" data-testid="v3-card-workspace-left-divider" role="separator" aria-orientation="vertical" aria-label={t("cards.cardAndChatWidth")} aria-valuenow={resolved.totalWidth} aria-valuemin={resolved.totalMinimum} aria-valuemax={workspaceWidth} aria-valuetext={t("cards.pixels", {width:Math.round(resolved.totalWidth)})} tabIndex={0} onKeyDown={event=>key(event,"left")}>
     <DragHandle widthPx={V3_PANEL_GAP_PX} onDrag={delta=>drag(delta,"left")}/>
    </div>
    {panes}
   </div>
  </div>
 </div>;
 return host?createPortal(content,host):content;
}
