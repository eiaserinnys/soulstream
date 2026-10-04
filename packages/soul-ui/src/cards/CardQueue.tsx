import { useState, type ReactNode } from "react";
import { DndContext, KeyboardCode, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DraggableAttributes, type DraggableSyntheticListeners } from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { DashboardIconCap } from "../components/DashboardIconCap";
import type { CardRow } from "./card-types";
import { queueAfterId } from "./card-api";
import { useCardStore } from "./card-store";

export interface CardQueueStatusActivator {
 setActivatorNodeRef(node:HTMLElement|null):void;
 attributes:DraggableAttributes;
 listeners:DraggableSyntheticListeners;
 disabled:boolean;
 popupOpen:boolean;
 onPopupOpenChange(open:boolean):void;
}

export function CardQueue({cards,renderRow,layout="list",activatorMode="handle",onReorder}: {
 cards:readonly CardRow[];
 renderRow(card:CardRow,handle:ReactNode,activator?:CardQueueStatusActivator):ReactNode;
 layout?:"list"|"grid";
 activatorMode?:"handle"|"status-chip";
 onReorder?(ids:readonly string[]):void|Promise<void>;
}) {
 const [pending,setPending]=useState(false),[error,setError]=useState<string|null>(null);
 const sensors=useSensors(
  useSensor(PointerSensor,activatorMode==="status-chip"?{activationConstraint:{distance:8}}:undefined),
  useSensor(KeyboardSensor,{coordinateGetter:sortableKeyboardCoordinates,...(activatorMode==="status-chip"?{keyboardCodes:{start:[KeyboardCode.Space],cancel:[KeyboardCode.Esc],end:[KeyboardCode.Space,KeyboardCode.Enter,KeyboardCode.Tab]}}:{})}),
 );
 return <><DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={event=>{
  const from=cards.findIndex(c=>c.id===event.active.id),to=cards.findIndex(c=>c.id===event.over?.id);
  if(pending||from<0||to<0||from===to)return;
  const moved=cards[from],ids=arrayMove(cards.map(c=>c.id),from,to);
  setPending(true);setError(null);
  const save=onReorder?Promise.resolve(onReorder(ids)):
   useCardStore.getState().mutate(moved.id,"/queue-position",{afterCardId:queueAfterId(ids,moved.id),expectedVersion:moved.version});
  void save.catch(e=>setError(String(e))).finally(()=>setPending(false));
 }}><SortableContext items={cards.map(c=>c.id)} strategy={layout==="grid"?rectSortingStrategy:verticalListSortingStrategy}>{cards.map(card=><QueueItem key={card.id} card={card} pending={pending} renderRow={renderRow} layout={layout} activatorMode={activatorMode}/>)}</SortableContext></DndContext>{error?<p role="alert">{error}</p>:null}</>;
}

function QueueItem({card,pending,renderRow,layout,activatorMode}:{card:CardRow;pending:boolean;renderRow(card:CardRow,handle:ReactNode,activator?:CardQueueStatusActivator):ReactNode;layout:"list"|"grid";activatorMode:"handle"|"status-chip"}) {
 const [popupOpen,setPopupOpen]=useState(false);
 const {attributes,listeners,setNodeRef,setActivatorNodeRef,transform,transition}=useSortable({id:card.id,disabled:pending||popupOpen});
 const activator:CardQueueStatusActivator={setActivatorNodeRef,attributes,listeners,disabled:pending,popupOpen,onPopupOpenChange:setPopupOpen};
 const handle=activatorMode==="handle"?<span ref={element=>setActivatorNodeRef(element?.querySelector("button")??null)}><DashboardIconCap size={layout==="grid"?"small":"default"} label={`${card.title} 순서 변경`} disabled={pending} {...attributes} {...listeners} onClick={event=>event.stopPropagation()}><GripVertical className="h-4 w-4"/></DashboardIconCap></span>:null;
 return <div ref={setNodeRef} style={{transform:CSS.Transform.toString(transform),transition}}>{renderRow(card,handle,activatorMode==="status-chip"?activator:undefined)}</div>;
}
