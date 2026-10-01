import { useRef, useState, type ComponentProps } from "react";
import { CardDetailPane } from "./CardDetailPane";
import { WorkspaceSessionColumn } from "./WorkspaceSessionColumn";
import { DEFAULT_WORKSPACE_SPLIT, clampWorkspaceSplit, workspaceSplitForKey } from "./folder-workspace-run-model";
import { V3_PANEL_GAP_PX } from "./v3-layout-metrics";

/** Card overlay uses the folder workspace's panel, split and mobile classes. */
export function CardWorkspace({cardId,folders,onClose,onOpenSession,mobileMode,mobileTab,...chat}: {
 cardId:string;folders:ComponentProps<typeof CardDetailPane>["folders"];onClose():void;
 onOpenSession:ComponentProps<typeof CardDetailPane>["onOpenSession"];mobileMode:boolean;mobileTab:string;
} & Omit<ComponentProps<typeof WorkspaceSessionColumn>,"chatClassName"|"chatTestId"|"resizeClassName"|"resizeTestId"|"onResize"|"onResizeKeyDown">) {
 const workspace=useRef<HTMLDivElement>(null);
 const [split,setSplit]=useState(DEFAULT_WORKSPACE_SPLIT);
 return <div className="v3-workspace-scrim is-chat-open" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}>
  <div ref={workspace} className="v3-workspace is-chat-open" data-testid="v3-card-workspace" data-placement="overlay" data-mobile-view={mobileMode?mobileTab:undefined}
   style={!mobileMode?{gridTemplateColumns:`minmax(0, calc(${split}% - ${V3_PANEL_GAP_PX/2}px)) ${V3_PANEL_GAP_PX}px minmax(0, 1fr)`}:undefined}>
   <CardDetailPane cardId={cardId} folders={folders} onClose={onClose} onOpenSession={onOpenSession}/>
   <WorkspaceSessionColumn {...chat} chatClassName="" chatTestId="v3-card-session-chat" resizeClassName="v3-workspace-divider" resizeTestId="v3-card-workspace-divider"
    onResize={delta=>setSplit(value=>clampWorkspaceSplit(value+delta*document.documentElement.clientWidth/(workspace.current?.getBoundingClientRect().width??document.documentElement.clientWidth)))}
    onResizeKeyDown={event=>{const next=workspaceSplitForKey(split,event.key);if(next!==null){event.preventDefault();setSplit(next);}}}/>
  </div>
 </div>;
}
