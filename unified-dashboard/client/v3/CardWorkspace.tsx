import { useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { CardDetailPane } from "./CardDetailPane";
import { WorkspaceSessionColumn } from "./WorkspaceSessionColumn";
import { cardWorkspaceWidthForKey, clampCardWorkspaceWidth, defaultCardWorkspaceWidth, resizeCardWorkspaceWidth } from "./folder-workspace-run-model";
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
 const [splitWidth,setSplitWidth]=useState<number|null>(null);
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
 const cardWidth=splitWidth===null?defaultCardWorkspaceWidth(workspaceWidth):clampCardWorkspaceWidth(splitWidth,workspaceWidth);
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
   data-card-width-px={Math.round(cardWidth)}
   style={!mobileMode&&workspaceWidth>0?{gridTemplateColumns:`${cardWidth}px ${V3_PANEL_GAP_PX}px minmax(0, 1fr)`}:undefined}>
   <CardDetailPane cardId={cardId} folders={folders} onClose={onClose} onOpenSession={onOpenSession} initialSessionId={initialSessionId} sampleDetail={sampleDetail} sampleExecution={sampleExecution} onSampleChange={onSampleChange}/>
   <WorkspaceSessionColumn {...chat} chatClassName="" chatTestId="v3-card-session-chat" resizeClassName="v3-workspace-divider" resizeTestId="v3-card-workspace-divider"
    onResize={delta=>{
     const width=workspaceWidthRef.current||workspace.current?.getBoundingClientRect().width||0;
     if(width<=0)return;
     const deltaPx=delta*document.documentElement.clientWidth/100;
     setSplitWidth(current=>resizeCardWorkspaceWidth(current??defaultCardWorkspaceWidth(width),width,deltaPx));
    }}
    onResizeKeyDown={event=>{
     const width=workspaceWidthRef.current||workspace.current?.getBoundingClientRect().width||0;
     if(width<=0)return;
     if(event.key==="Home"){event.preventDefault();setSplitWidth(null);return;}
     const next=cardWorkspaceWidthForKey(splitWidth??defaultCardWorkspaceWidth(width),width,event.key);
     if(next!==null){event.preventDefault();setSplitWidth(next);}
    }}/>
  </div>
 </div>;
 return host?createPortal(content,host):content;
}
