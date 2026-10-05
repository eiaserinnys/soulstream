import { useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { CardDetailPane } from "./CardDetailPane";
import { WorkspaceSessionColumn } from "./WorkspaceSessionColumn";
import { DragHandle } from "@seosoyoung/soul-ui";
import { cardWorkspaceLayout, cardWorkspaceLayoutForKey, resizeCardWorkspace, type CardWorkspaceLayout } from "./card-workspace-layout";
import { readV3CardWorkspaceLayout, writeV3CardWorkspaceLayout } from "./v3-session-panel-width";
import { V3_PANEL_GAP_PX } from "./v3-layout-metrics";

/** Card overlay uses the folder workspace's panel, split and mobile classes. */
export function CardWorkspace({cardId,folders,onClose,onOpenSession,mobileMode,mobileTab,initialSessionId,sampleDetail,sampleExecution,onSampleChange,...chat}: {
 cardId:string;folders:ComponentProps<typeof CardDetailPane>["folders"];onClose():void;
 onOpenSession:ComponentProps<typeof CardDetailPane>["onOpenSession"];mobileMode:boolean;mobileTab:string;
 initialSessionId?:ComponentProps<typeof CardDetailPane>["initialSessionId"];
 sampleExecution?:ComponentProps<typeof CardDetailPane>["sampleExecution"];
 sampleDetail?:ComponentProps<typeof CardDetailPane>["sampleDetail"];
 onSampleChange?:ComponentProps<typeof CardDetailPane>["onSampleChange"];
} & Omit<ComponentProps<typeof WorkspaceSessionColumn>,"chatClassName"|"chatTestId"|"resizeClassName"|"resizeTestId"|"onResize"|"onResizeKeyDown">) {
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
 useLayoutEffect(()=>{workspace.current?.querySelector<HTMLButtonElement>('button[aria-label="카드 닫기"]')?.focus({preventScroll:true});},[host]);
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
  if(width>0)update(resizeCardWorkspace(width,layout,delta*document.documentElement.clientWidth/100,edge));
 };
 const key=(event:import("react").KeyboardEvent<HTMLDivElement>,edge:"left"|"middle")=>{
  const next=cardWorkspaceLayoutForKey(workspaceWidthRef.current,layout,event.key,edge);
  if(next!==undefined){event.preventDefault();update(next);}
 };
 const panes=<>
  <CardDetailPane cardId={cardId} folders={folders} onClose={onClose} onOpenSession={onOpenSession} initialSessionId={initialSessionId} sampleDetail={sampleDetail} sampleExecution={sampleExecution} onSampleChange={onSampleChange}/>
  <WorkspaceSessionColumn {...chat} chatClassName="" chatTestId="v3-card-session-chat" resizeClassName="v3-workspace-divider" resizeTestId="v3-card-workspace-divider" onResize={delta=>drag(delta,"middle")} onResizeKeyDown={event=>key(event,"middle")}/>
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
  <div ref={workspace} className="v3-workspace is-chat-open" data-testid="v3-card-workspace" data-placement="overlay" data-mobile-view={mobileMode?mobileTab:undefined}
   data-card-width-px={Math.round(resolved.cardWidth)} data-pair-width-px={Math.round(resolved.totalWidth)}>
   {mobileMode?panes:<div className="v3-card-workspace-pair" style={workspaceWidth>0?{width:resolved.totalWidth,gridTemplateColumns:`${resolved.cardWidth}px ${V3_PANEL_GAP_PX}px minmax(0,1fr)`}:undefined}>
    <div className="v3-workspace-divider v3-card-workspace-left-divider" data-testid="v3-card-workspace-left-divider" role="separator" aria-orientation="vertical" aria-label="카드와 대화 전체 폭" tabIndex={0} onKeyDown={event=>key(event,"left")}>
     <DragHandle widthPx={V3_PANEL_GAP_PX} onDrag={delta=>drag(delta,"left")}/>
    </div>
    {panes}
   </div>}
  </div>
 </div>;
 return host?createPortal(content,host):content;
}
