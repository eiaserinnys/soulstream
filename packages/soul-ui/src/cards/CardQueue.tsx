import { useState, type ReactNode } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { DashboardIconCap } from "../components/DashboardIconCap";
import type { CardRow } from "./card-types";
import { queueAfterId } from "./card-api";
import { useCardStore } from "./card-store";
export function CardQueue({cards,renderRow}:{cards:readonly CardRow[];renderRow(card:CardRow,handle:ReactNode):ReactNode}) {
 const [pending,setPending]=useState(false),[error,setError]=useState<string|null>(null);
 const sensors=useSensors(useSensor(PointerSensor),useSensor(KeyboardSensor,{coordinateGetter:sortableKeyboardCoordinates}));
 return <><DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={event=>{
  const from=cards.findIndex(c=>c.id===event.active.id),to=cards.findIndex(c=>c.id===event.over?.id);
  if(pending||from<0||to<0||from===to)return;
  const moved=cards[from],ids=arrayMove(cards.map(c=>c.id),from,to);setPending(true);setError(null);
  void useCardStore.getState().mutate(moved.id,"/queue-position",{afterCardId:queueAfterId(ids,moved.id),expectedVersion:moved.version}).catch(e=>setError(String(e))).finally(()=>setPending(false));
 }}><SortableContext items={cards.map(c=>c.id)} strategy={verticalListSortingStrategy}>{cards.map(card=><QueueItem key={card.id} card={card} pending={pending} renderRow={renderRow}/>)}</SortableContext></DndContext>{error?<p role="alert">{error}</p>:null}</>;
}
function QueueItem({card,pending,renderRow}:{card:CardRow;pending:boolean;renderRow(card:CardRow,handle:ReactNode):ReactNode}) {
 const {attributes,listeners,setNodeRef,setActivatorNodeRef,transform,transition}=useSortable({id:card.id,disabled:pending});
 return <div ref={setNodeRef} style={{transform:CSS.Transform.toString(transform),transition}}>{renderRow(card,<DashboardIconCap label={`${card.title} 순서 변경`} disabled={pending} {...attributes} {...listeners}><GripVertical className="h-4 w-4"/></DashboardIconCap>)}</div>;
}
