import { useEffect, useMemo, useRef, useState, type ReactNode, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCenter, pointerWithin, useDraggable, useDroppable, useSensor, useSensors, type CollisionDetection, type KeyboardCoordinateGetter } from "@dnd-kit/core";
import { DashboardIconCap } from "@seosoyoung/soul-ui";
import { GripVertical } from "lucide-react";
import type { CardRow, CardStatus } from "@seosoyoung/soul-ui/cards/card-types";
import { CardBoardTransitionContext, type CardBoardTransitions } from "./card-board-transitions";
import { useCardBoardLayer } from "./card-board-layer";
const statuses=["todo","queued","running","blocked","review","done"] as const;

// Pointer releases outside a lane are cancelled; keyboard movement follows lane bounds.
const collisions:CollisionDetection=args=>args.pointerCoordinates ? pointerWithin(args) : closestCenter(args);
const laneCoordinates:KeyboardCoordinateGetter=(event,{context})=>{
  if(!["ArrowRight","ArrowLeft"].includes(event.code))return;
  event.preventDefault();
  const status=context.over?.data.current?.status??context.active?.data.current?.status;
  const index=statuses.indexOf(status);
  const next=statuses[index+(event.code==="ArrowRight"?1:-1)];
  if(!next)return;
  const rect=context.droppableRects.get(`lane-${next}`);
  if(!rect)return;
  return {x:rect.left,y:rect.top};
};

/** Reuses the product's dnd-kit sensors/lifecycle with isolated grip activators. */
export function CardBoardDnd({children,cards,renderCard}:{children:ReactNode;cards:readonly CardRow[];renderCard(card:CardRow,handle:ReactNode,preview?:boolean):ReactNode}) {
  const [activeId,setActiveId]=useState<string|null>(null);
  const overlayHost=useRef<Element|null>(null);
  const layer=useCardBoardLayer();
  useEffect(()=>{if(activeId)return layer?.claim();},[layer,activeId]);
  const requests=useRef(new Map<string,(status:CardStatus)=>void>());
  const transitions=useMemo<CardBoardTransitions>(()=>({
    register(id,request){requests.current.set(id,request);return ()=>{if(requests.current.get(id)===request)requests.current.delete(id);};},
    request(id,status){requests.current.get(id)?.(status);},
  }),[]);
  const sensors=useSensors(useSensor(PointerSensor,{activationConstraint:{distance:8}}),
    useSensor(KeyboardSensor,{coordinateGetter:laneCoordinates,scrollBehavior:"auto"}));
  const activeCard=cards.find(card=>card.id===activeId);
  const overlay=<DragOverlay className="v3-card-board-drag-overlay" dropAnimation={null}>{activeCard?renderCard(activeCard,null,true):null}</DragOverlay>;
  return <CardBoardTransitionContext.Provider value={transitions}>
    <DndContext sensors={sensors} collisionDetection={collisions}
      accessibility={{screenReaderInstructions:{draggable:"스페이스로 카드를 잡고 좌우 화살표로 단계를 선택합니다. 스페이스로 옮기고 Escape로 취소합니다. 막힘 단계는 직접 선택할 수 없습니다."}}}
      autoScroll={{canScroll:element=>element.classList.contains("v3-card-board")||element.classList.contains("v3-card-board-lane")}}
      onDragStart={({active,activatorEvent})=>{
        overlayHost.current=(activatorEvent.target as HTMLElement).closest(".v3-shell");
        setActiveId(String(active.id));
      }} onDragCancel={()=>setActiveId(null)}
      onDragEnd={({active,over})=>{
        setActiveId(null);
        if(!over)return;
        const status=over.data.current?.status as CardStatus|undefined;
        if(status && status!==active.data.current?.status)transitions.request(String(active.id),status);
      }}>
      {children}
      {overlayHost.current?createPortal(overlay,overlayHost.current):overlay}
    </DndContext>
  </CardBoardTransitionContext.Provider>;
}
export function CardBoardLane({status,label,children,style}:{status:CardStatus;label:string;children:ReactNode;style?:CSSProperties}) {
  const {setNodeRef,isOver}=useDroppable({id:`lane-${status}`,data:{status}});
  return <section ref={setNodeRef} style={style} className={`v3-card-board-column${isOver?status==="blocked"?" is-drop-unavailable":" is-drop-target":""}`}
    data-board-column={status} aria-label={label} aria-description={status==="blocked"?"막힘 단계로 직접 옮길 수 없습니다":undefined}>
    {children}
  </section>;
}
export function CardBoardItem({card,renderCard}:{card:CardRow;renderCard(card:CardRow,handle:ReactNode):ReactNode}) {
  const {setNodeRef,setActivatorNodeRef,attributes,listeners,isDragging}=useDraggable({id:card.id,data:{status:card.status}});
  const handle=<span ref={element=>setActivatorNodeRef(element?.querySelector("button")??null)}><DashboardIconCap size="small" label={`${card.title} 단계 이동`} {...attributes} {...listeners}
    onClick={event=>event.stopPropagation()} className="v3-card-board-grip"><GripVertical className="h-4 w-4" aria-hidden="true"/></DashboardIconCap></span>;
  return <div ref={setNodeRef} className={isDragging?"v3-card-board-item is-dragging":"v3-card-board-item"}>
    {renderCard(card,handle)}
  </div>;
}
