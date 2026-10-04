import { useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { CardDetailPane } from "./CardDetailPane";
import { WorkspaceSessionColumn } from "./WorkspaceSessionColumn";
import { DEFAULT_WORKSPACE_SPLIT, clampWorkspaceSplit, workspaceSplitForKey } from "./folder-workspace-run-model";
import { V3_PANEL_GAP_PX } from "./v3-layout-metrics";

/** Card overlay uses the folder workspace's panel, split and mobile classes. */
export function CardWorkspace({cardId,folders,onClose,onOpenSession,mobileMode,mobileTab,sampleDetail,sampleExecution,...chat}: {
 cardId:string;folders:ComponentProps<typeof CardDetailPane>["folders"];onClose():void;
 onOpenSession:ComponentProps<typeof CardDetailPane>["onOpenSession"];mobileMode:boolean;mobileTab:string;
 sampleExecution?:ComponentProps<typeof CardDetailPane>["sampleExecution"];
 sampleDetail?:ComponentProps<typeof CardDetailPane>["sampleDetail"];
} & Omit<ComponentProps<typeof WorkspaceSessionColumn>,"chatClassName"|"chatTestId"|"resizeClassName"|"resizeTestId"|"onResize"|"onResizeKeyDown">) {
 const workspace=useRef<HTMLDivElement>(null);
 const [split,setSplit]=useState(DEFAULT_WORKSPACE_SPLIT);
 const [host,setHost]=useState<Element|null>(null);
 useLayoutEffect(()=>{
  const focus=document.activeElement as HTMLElement|null;
  // Mount after the board portal in the same shell and existing overlay layer.
  setHost(workspace.current?.closest('.v3-shell')??null);
  return ()=>{if(focus?.isConnected)focus.focus({preventScroll:true});};
 },[]);
 useLayoutEffect(()=>{workspace.current?.querySelector<HTMLButtonElement>('button[aria-label="카드 닫기"]')?.focus({preventScroll:true});},[host]);
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
   style={!mobileMode?{gridTemplateColumns:`minmax(0, calc(${split}% - ${V3_PANEL_GAP_PX/2}px)) ${V3_PANEL_GAP_PX}px minmax(0, 1fr)`}:undefined}>
   <CardDetailPane cardId={cardId} folders={folders} onClose={onClose} onOpenSession={onOpenSession} sampleDetail={sampleDetail} sampleExecution={sampleExecution}/>
   <WorkspaceSessionColumn {...chat} chatClassName="" chatTestId="v3-card-session-chat" resizeClassName="v3-workspace-divider" resizeTestId="v3-card-workspace-divider"
    onResize={delta=>setSplit(value=>clampWorkspaceSplit(value+delta*document.documentElement.clientWidth/(workspace.current?.getBoundingClientRect().width??document.documentElement.clientWidth)))}
    onResizeKeyDown={event=>{const next=workspaceSplitForKey(split,event.key);if(next!==null){event.preventDefault();setSplit(next);}}}/>
  </div>
 </div>;
 return host?createPortal(content,host):content;
}
