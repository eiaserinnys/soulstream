import { Fragment,useLayoutEffect,useRef,useState,type ReactNode } from "react";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { PostItGrid } from "./PostItCard";
import type { CardCompletionOption } from "./CardCompletionFilter";
import "./v3-card-board.css";
import { useBoardPan } from "./use-board-pan";
import { completedGridLayout } from "@seosoyoung/soul-ui/cards/completed-cards";
import { CompletedCardGrid } from "./CompletedCardGrid";
import type { CompletedBrowser } from "./use-completed-cards";

export const boardColumns = [
  {status:"todo",label:"드래프트"}, {status:"queued",label:"대기"},
  {status:"running",label:"실행 중"}, {status:"blocked",label:"막힘"},
  {status:"review",label:"검수 대기"}, {status:"done",label:"완료"}, {status:"cancelled",label:"취소"},
] as const;

/** Existing active lanes and a viewport-sized completed lane share card mutations. */
export function CardBoard({cards, renderCard, completion, draftAction,completed,hideEmptyLanes=false}: {
  cards: readonly CardRow[]; renderCard(card:CardRow):ReactNode; draftAction?:ReactNode; completion?:CardCompletionOption;completed?:CompletedBrowser;hideEmptyLanes?:boolean;
}) {
  const pan = useBoardPan();
  const root=useRef<HTMLDivElement>(null);
  const [doneWidth,setDoneWidth]=useState<number>();
  useLayoutEffect(()=>{
    const board=root.current;if(!board)return;
    const measure=()=>{
      const probe=board.querySelector<HTMLElement>(".v3-completed-measure")!;
      const rect=probe.getBoundingClientRect(),style=getComputedStyle(probe),outer=getComputedStyle(board);
      if(rect.width)setDoneWidth(completedGridLayout(board.clientWidth-parseFloat(outer.paddingLeft)-parseFloat(outer.paddingRight),rect.width,parseFloat(style.columnGap),rect.height).width);
    };
    measure();const observer=new ResizeObserver(measure);observer.observe(board);observer.observe(board.querySelector(".v3-completed-measure")!);return()=>observer.disconnect();
  },[]);
  const visible=cards.filter(card=>!card.archived);
  const columns=boardColumns.filter(({status})=>completion?.includeCompleted!==false||(status!=="done"&&status!=="cancelled")).map(column=>({
    ...column,cards:visible.filter(card=>card.status===column.status),
  })).filter(column=>!hideEmptyLanes||column.cards.length>0);
  return <PostItGrid ref={root} {...pan} className="v3-card-board" variant="compact"><span className="v3-completed-measure" aria-hidden="true"/>{columns.length===0&&hideEmptyLanes?<p className="v3-card-board-empty">카드가 없습니다</p>:null}{columns.map(({status,label,cards:column})=>{
    const sorted=column.sort((a,b)=>{
      const left=status==="queued"?a.queuePositionKey??"":a.positionKey;
      const right=status==="queued"?b.queuePositionKey??"":b.positionKey;
      return left<right?-1:left>right?1:0;
    });
    return <section key={status} className="v3-card-board-column" data-board-column={status} aria-label={label} style={status==="done"?{width:doneWidth}:undefined}>
      <div className="v3-detail-section-head"><h3>{label}</h3><span>{column.length}개{status==="done"?" 표시":""}</span>{status==="todo"?draftAction:null}</div>
      {status==="done"&&completed?<CompletedCardGrid browser={completed} renderCard={card=>renderCard(card)}/>:<div className="v3-card-board-lane">
        {sorted.length ? sorted.map(card=><Fragment key={card.id}>{renderCard(card)}</Fragment>)
        : <p className="v3-card-board-empty">카드가 없습니다</p>}
      </div>}
    </section>;
  })}</PostItGrid>;
}
