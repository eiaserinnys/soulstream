import { useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DashboardIconCap } from "@seosoyoung/soul-ui";
import { Maximize2, X } from "lucide-react";
import { CardBoard } from "./CardBoard";
import { CardCompletionFilter } from "./CardCompletionFilter";
import { CardBoardLayerContext } from "./card-board-layer";

/** One mounted board owns its scope, option and scroll even while expanded. */
export function CardBoardWorkspace({title,actions,...boardProps}:ComponentProps<typeof CardBoard>&{title:string;actions?:ReactNode}) {
  const [expanded,setExpanded]=useState(false);
  const root=useRef<HTMLDivElement>(null);
  const nestedLayers=useRef(0);
  const layer=useMemo(()=>({claim(){nestedLayers.current++;return ()=>{nestedLayers.current--;};}}),[]);
  const snapshot=useRef<{focus:HTMLElement|null;horizontal:number;vertical:number[];completion?:boolean}|null>(null);
  const expand=()=>{
    const board=root.current!.querySelector<HTMLElement>(".v3-card-board")!;
    snapshot.current={focus:document.activeElement as HTMLElement,horizontal:board.scrollLeft,
      vertical:[...board.querySelectorAll<HTMLElement>(".v3-card-board-lane")].map(lane=>lane.scrollTop),completion:boardProps.completion?.includeCompleted};
    setExpanded(true);
  };
  const collapse=()=>{
    if(snapshot.current?.completion!==undefined)boardProps.completion?.onChange(snapshot.current.completion);
    setExpanded(false);
  };
  useLayoutEffect(()=>{
    if(!snapshot.current)return;
    const board=root.current!.querySelector<HTMLElement>(".v3-card-board")!;
    board.scrollLeft=snapshot.current.horizontal;
    board.querySelectorAll<HTMLElement>(".v3-card-board-lane").forEach((lane,index)=>{lane.scrollTop=snapshot.current!.vertical[index];});
    if(expanded)root.current?.querySelector<HTMLButtonElement>('button[aria-label="확대 닫기"]')?.focus({preventScroll:true});
    else {
      const focus=snapshot.current.focus?.isConnected?snapshot.current.focus:root.current?.querySelector<HTMLButtonElement>('button[aria-label="보드 확대"]');
      focus?.focus({preventScroll:true});snapshot.current=null;
    }
  },[expanded]);
  const content=<div ref={root} className={`v3-card-board-workspace${expanded?" is-expanded border border-glass-border glass-strong glass-chrome lg-rim":""}`}
    data-card-board-expanded={expanded} role={expanded?"dialog":undefined} aria-modal={expanded||undefined} aria-label={expanded?`${title} 보드`:undefined}
    onKeyDown={event=>{
      if(!expanded)return;
      // Popup portals and the sensor own their Escape; only the idle board closes.
      if(nestedLayers.current)return;
      if(event.key==="Escape" && !event.defaultPrevented){event.preventDefault();event.stopPropagation();collapse();}
      if(event.key==="Tab"){
        const focusable=[...root.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')].filter(node=>node.getClientRects().length);
        const first=focusable[0],last=focusable.at(-1);
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }
    }}>
    <div className="v3-detail-section-head v3-folder-card-head"><h3>{title}</h3><span>{boardProps.cards.filter(card=>!card.archived&&card.status!=="cancelled"&&(boardProps.completion?.includeCompleted!==false||card.status!=="done")).length}개</span>
      {boardProps.completion?<CardCompletionFilter {...boardProps.completion} hiddenCount={boardProps.cards.filter(card=>!card.archived&&card.status==="done").length}/>:null}
      <span className="v3-spacer"/><div className="v3-card-actions">{expanded?null:actions}
        {expanded?<DashboardIconCap size="small" label="확대 닫기" onClick={collapse}><X className="h-4 w-4"/></DashboardIconCap>
          :<DashboardIconCap size="small" label="보드 확대" onClick={expand}><Maximize2 className="h-4 w-4"/></DashboardIconCap>}
      </div>
    </div>
    <CardBoard {...boardProps}/>
  </div>;
  // Escapes backdrop-filter containing blocks while inheriting the actual shell tokens.
  const shell=root.current?.closest(".v3-shell");
  return <CardBoardLayerContext.Provider value={layer}>{expanded && shell ? createPortal(content,shell) : content}</CardBoardLayerContext.Provider>;
}
