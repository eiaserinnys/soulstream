import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DashboardIconCap } from "@seosoyoung/soul-ui";
import { Maximize2, X } from "lucide-react";
import { CardBoard, boardColumns } from "./CardBoard";
import { CardCompletionFilter } from "./CardCompletionFilter";
import { CompletedCardBrowserControls, CompletedCardBrowserFeedback, type CompletedGridSnapshot } from "./CompletedCardGrid";
import { CardBoardLayerContext } from "./card-board-layer";
import { useCardNavigation } from "./card-navigation";

type BoardStatus = (typeof boardColumns)[number]["status"];
type BoardScrollAnchor = { status: BoardStatus; delta: number };
type BoardLaneScrollPosition = number|CompletedGridSnapshot;
type BoardSnapshot = { focus: HTMLElement | null; horizontal: BoardScrollAnchor | null; vertical: Partial<Record<BoardStatus, BoardLaneScrollPosition>> };

function contentLeft(board:HTMLElement) {
  const padding=parseFloat(getComputedStyle(board).paddingLeft)||0;
  return board.getBoundingClientRect().left+board.clientLeft+padding;
}

function boardColumnsIn(board:HTMLElement) {
  return [...board.querySelectorAll<HTMLElement>(".v3-card-board-column[data-board-column]")];
}

function captureHorizontalAnchor(board:HTMLElement, preferredStatus?:BoardStatus):BoardScrollAnchor|null {
  const columns=boardColumnsIn(board);
  if(!columns.length)return null;
  const left=contentLeft(board);
  const column=preferredStatus
    ? columns.find(item=>item.dataset.boardColumn===preferredStatus)
    : columns.find(item=>item.getBoundingClientRect().right>left)??columns[0];
  if(!column)return null;
  return {status:column.dataset.boardColumn as BoardStatus,delta:left-column.getBoundingClientRect().left};
}

function resolveAnchor(anchor:BoardScrollAnchor|null,statuses:readonly BoardStatus[]):BoardScrollAnchor|null {
  if(!statuses.length)return null;
  if(!anchor)return null;
  if(statuses.includes(anchor.status))return anchor;
  const oldIndex=boardColumns.findIndex(column=>column.status===anchor.status);
  const nearest=statuses.reduce((best,status)=>{
    const distance=Math.abs(boardColumns.findIndex(column=>column.status===status)-oldIndex);
    const bestDistance=Math.abs(boardColumns.findIndex(column=>column.status===best)-oldIndex);
    return distance<bestDistance?status:best;
  },statuses[0]);
  return {status:nearest,delta:anchor.delta};
}

function restoreHorizontalAnchor(board:HTMLElement, anchor:BoardScrollAnchor|null, statuses:readonly BoardStatus[]):BoardScrollAnchor|null {
  const target=resolveAnchor(anchor,statuses);
  if(!target){board.scrollLeft=0;return null;}
  const column=boardColumnsIn(board).find(item=>item.dataset.boardColumn===target.status);
  if(!column){board.scrollLeft=0;return null;}
  const correction=target.delta-(contentLeft(board)-column.getBoundingClientRect().left);
  const maxScroll=Math.max(0,board.scrollWidth-board.clientWidth);
  board.scrollLeft=Math.max(0,Math.min(maxScroll,board.scrollLeft+correction));
  return captureHorizontalAnchor(board,target.status)??target;
}

function saveVerticalScroll(board:HTMLElement, positions:Partial<Record<BoardStatus,BoardLaneScrollPosition>>) {
  for(const column of boardColumnsIn(board)) {
    const status=column.dataset.boardColumn as BoardStatus;
    if(status==="done")continue;
    const lane=column.querySelector<HTMLElement>(".v3-card-board-lane");
    if(lane)positions[status]=lane.scrollTop;
  }
}

function restoreVerticalScroll(board:HTMLElement, positions:Partial<Record<BoardStatus,BoardLaneScrollPosition>>) {
  for(const column of boardColumnsIn(board)) {
    const status=column.dataset.boardColumn as BoardStatus;
    if(status==="done")continue;
    const lane=column.querySelector<HTMLElement>(".v3-card-board-lane");
    if(lane)lane.scrollTop=typeof positions[status]==="number"?positions[status]:0;
  }
}

/** One mounted board owns its scope, option and scroll even while expanded. */
export function CardBoardWorkspace({title,actions,draftAction,initialExpanded=false,...boardProps}:Omit<ComponentProps<typeof CardBoard>,"completedGridSnapshot"|"onCompletedGridSnapshotChange">&{title:string;actions?:ReactNode;initialExpanded?:boolean}) {
  const [expanded,setExpanded]=useState(initialExpanded);
  const [completedGridSnapshot,setCompletedGridSnapshot]=useState<CompletedGridSnapshot|null>(null);
  const detailOpen=useCardNavigation(state=>state.cardId!==null);
  const root=useRef<HTMLDivElement>(null);
  const nestedLayers=useRef(0);
  const layer=useMemo(()=>({claim(){nestedLayers.current++;return ()=>{nestedLayers.current--;};}}),[]);
  const snapshot=useRef<BoardSnapshot|null>(null);
  const currentAnchor=useRef<BoardScrollAnchor|null>(null);
  const verticalPositions=useRef<Partial<Record<BoardStatus,BoardLaneScrollPosition>>>({});
  const mainStatuses=useRef<BoardStatus[]|null>(null);
  const previousExpanded=useRef(expanded);
  const completedResetKey=boardProps.completed?.resetKey;
  const previousCompletedResetKey=useRef(completedResetKey);
  const completionStatuses=boardColumns.filter(({status})=>boardProps.completion?.includeCompleted!==false||(status!=="done"&&status!=="cancelled"));
  const populatedStatuses=completionStatuses.filter(({status})=>status==="done"&&boardProps.completed
    ?boardProps.completed.cards.length>0
    :boardProps.cards.some(card=>!card.archived&&card.status===status));
  const renderedStatuses=expanded?completionStatuses.map(({status})=>status):populatedStatuses.map(({status})=>status);
  const renderedStatusKey=renderedStatuses.join(",");

  const rememberCompletedGridSnapshot=useCallback((snapshot:CompletedGridSnapshot)=>{
    if(!expanded)verticalPositions.current.done=snapshot;
  },[expanded]);

  useLayoutEffect(()=>{
    if(previousCompletedResetKey.current===completedResetKey)return;
    previousCompletedResetKey.current=completedResetKey;
    delete verticalPositions.current.done;
    if(snapshot.current)delete snapshot.current.vertical.done;
    setCompletedGridSnapshot(null);
  },[completedResetKey]);

  const expand=()=>{
    const board=root.current!.querySelector<HTMLElement>(".v3-card-board")!;
    saveVerticalScroll(board,verticalPositions.current);
    const horizontal=captureHorizontalAnchor(board)??currentAnchor.current;
    currentAnchor.current=horizontal;
    snapshot.current={focus:document.activeElement as HTMLElement,horizontal,vertical:{...verticalPositions.current}};
    const doneSnapshot=verticalPositions.current.done;
    setCompletedGridSnapshot(doneSnapshot&&typeof doneSnapshot!=="number"?doneSnapshot:null);
    setExpanded(true);
  };
  const collapse=()=>{
    const doneSnapshot=snapshot.current?.vertical.done;
    setCompletedGridSnapshot(doneSnapshot&&typeof doneSnapshot!=="number"?doneSnapshot:null);
    setExpanded(false);
  };

  useLayoutEffect(()=>{
    const element=root.current;
    if(!element)return;
    const rememberScroll=(event:Event)=>{
      if(expanded)return;
      const target=event.target;
      if(!(target instanceof HTMLElement))return;
      if(target.classList.contains("v3-card-board"))currentAnchor.current=captureHorizontalAnchor(target)??currentAnchor.current;
      else if(target.classList.contains("v3-card-board-lane")) {
        const status=target.closest<HTMLElement>("[data-board-column]")?.dataset.boardColumn as BoardStatus|undefined;
        if(status&&status!=="done")verticalPositions.current[status]=target.scrollTop;
      }
    };
    element.addEventListener("scroll",rememberScroll,true);
    return()=>element.removeEventListener("scroll",rememberScroll,true);
  },[expanded]);

  useLayoutEffect(()=>{
    const board=root.current?.querySelector<HTMLElement>(".v3-card-board");
    if(!board)return;
    const wasExpanded=previousExpanded.current;
    if(expanded) {
      if(!wasExpanded&&snapshot.current) {
        const saved=snapshot.current;
        currentAnchor.current=restoreHorizontalAnchor(board,saved.horizontal,renderedStatuses);
        restoreVerticalScroll(board,saved.vertical);
        saveVerticalScroll(board,verticalPositions.current);
        root.current?.querySelector<HTMLButtonElement>('button[aria-label="확대 닫기"]')?.focus({preventScroll:true});
      }
    } else if(wasExpanded&&snapshot.current) {
      const saved=snapshot.current;
      currentAnchor.current=restoreHorizontalAnchor(board,saved.horizontal,renderedStatuses);
      restoreVerticalScroll(board,saved.vertical);
      saveVerticalScroll(board,verticalPositions.current);
      const focus=saved.focus?.isConnected?saved.focus:root.current?.querySelector<HTMLButtonElement>('button[aria-label="보드 확대"]');
      focus?.focus({preventScroll:true});
      snapshot.current=null;
      mainStatuses.current=[...renderedStatuses];
    } else if(!expanded) {
      const previous=mainStatuses.current;
      if(previous===null) {
        saveVerticalScroll(board,verticalPositions.current);
        currentAnchor.current=captureHorizontalAnchor(board);
      } else if(previous.join(",")!==renderedStatusKey) {
        const anchor=currentAnchor.current??captureHorizontalAnchor(board);
        currentAnchor.current=restoreHorizontalAnchor(board,anchor,renderedStatuses);
        for(const column of boardColumnsIn(board)) {
          const status=column.dataset.boardColumn as BoardStatus;
          if(status==="done")continue;
          const lane=column.querySelector<HTMLElement>(".v3-card-board-lane");
          if(!lane)continue;
          if(previous.includes(status))verticalPositions.current[status]=lane.scrollTop;
          else {
            const position=verticalPositions.current[status];
            lane.scrollTop=typeof position==="number"?position:0;
            verticalPositions.current[status]=lane.scrollTop;
          }
        }
      } else {
        saveVerticalScroll(board,verticalPositions.current);
        if(!currentAnchor.current)currentAnchor.current=captureHorizontalAnchor(board);
      }
      mainStatuses.current=[...renderedStatuses];
    }
    previousExpanded.current=expanded;
  },[expanded,renderedStatusKey]);

  const content=<div ref={root} className={`v3-card-board-workspace${expanded?" is-expanded border border-glass-border glass-strong glass-chrome lg-rim":""}`}
    data-card-board-expanded={expanded} role={expanded?"dialog":undefined} aria-modal={expanded||undefined} aria-label={expanded?`${title} 보드`:undefined}
    onKeyDown={event=>{
      if(!expanded)return;
      // Popup portals and the sensor own their Escape; only the idle board closes.
      if(nestedLayers.current || detailOpen)return;
      if(event.key==="Escape" && !event.defaultPrevented){event.preventDefault();event.stopPropagation();collapse();}
      if(event.key==="Tab"){
        const focusable=[...root.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')].filter(node=>node.getClientRects().length);
        const first=focusable[0],last=focusable.at(-1);
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }
    }}>
    <div className="v3-detail-section-head v3-folder-card-head"><h3>{title}</h3><span>{boardProps.cards.filter(card=>!card.archived&&(boardProps.completion?.includeCompleted!==false||(card.status!=="done"&&card.status!=="cancelled"))).length}개 표시</span>
      <span className="v3-spacer"/>
      {boardProps.completion?<CardCompletionFilter {...boardProps.completion} hiddenCount={boardProps.cards.filter(card=>!card.archived&&card.status==="done").length}/>:null}
      <div className="v3-card-actions">{draftAction}{expanded?null:actions}
        {expanded?<DashboardIconCap size="small" label="확대 닫기" onClick={collapse}><X className="h-4 w-4"/></DashboardIconCap>
          :<DashboardIconCap size="small" label="보드 확대" onClick={expand}><Maximize2 className="h-4 w-4"/></DashboardIconCap>}
      </div>
    </div>
    {!expanded&&boardProps.completion?.includeCompleted&&boardProps.completed?<>
      <CompletedCardBrowserControls browser={boardProps.completed}/>
      <CompletedCardBrowserFeedback browser={boardProps.completed}/>
    </>:null}
    <CardBoard {...boardProps} hideEmptyLanes={!expanded} completedGridSnapshot={completedGridSnapshot} onCompletedGridSnapshotChange={rememberCompletedGridSnapshot}/>
  </div>;
  // Escapes backdrop-filter containing blocks while inheriting the actual shell tokens.
  const shell=root.current?.closest(".v3-shell");
  return <CardBoardLayerContext.Provider value={layer}>{expanded && shell ? createPortal(content,shell) : content}</CardBoardLayerContext.Provider>;
}
