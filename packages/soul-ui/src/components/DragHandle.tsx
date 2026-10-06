/**
 * DragHandle - 패널 간 리사이즈를 위한 드래그 핸들
 *
 * 마우스 드래그로 좌우 패널 크기를 조절합니다.
 * deltaPercent = (dx / viewportWidth) * 100 으로 환산하여 콜백에 전달합니다.
 */

import { useCallback, useEffect, useRef } from "react";

export interface DragHandleProps {
  onDrag: (deltaPercent: number) => void;
  widthPx?: number;
}

export function DragHandle({ onDrag, widthPx = 4 }: DragHandleProps) {
  const pointer = useRef<number|null>(null);
  const target = useRef<HTMLDivElement|null>(null);
  const previous = useRef({cursor:"",userSelect:""});
  const lastX = useRef(0);
  const onDragRef = useRef(onDrag);
  onDragRef.current = onDrag;

  const lineRef = useRef<HTMLDivElement>(null);

  const finishDrag=useCallback(()=>{
    const id=pointer.current;
    if(id===null)return;
    pointer.current=null;
    window.removeEventListener("blur",finishDrag);
    document.body.style.cursor=previous.current.cursor;
    document.body.style.userSelect=previous.current.userSelect;
    if(target.current?.hasPointerCapture(id))target.current.releasePointerCapture(id);
    target.current=null;
  },[]);
  useEffect(()=>finishDrag,[finishDrag]);
  const onPointerDown=useCallback((event:React.PointerEvent<HTMLDivElement>)=>{
    event.preventDefault();finishDrag();
    pointer.current=event.pointerId;target.current=event.currentTarget;lastX.current=event.clientX;
    previous.current={cursor:document.body.style.cursor,userSelect:document.body.style.userSelect};
    event.currentTarget.setPointerCapture(event.pointerId);
    window.addEventListener("blur",finishDrag);
    document.body.style.cursor="col-resize";document.body.style.userSelect="none";
  },[finishDrag]);
  const onPointerMove=useCallback((event:React.PointerEvent<HTMLDivElement>)=>{
    if(pointer.current!==event.pointerId)return;
    const dx=event.clientX-lastX.current;lastX.current=event.clientX;
    const width=document.documentElement.clientWidth;
    if(width>0)onDragRef.current(dx/width*100);
  },[]);

  return (
    <div
      onPointerDown={onPointerDown} onPointerMove={onPointerMove}
      onPointerUp={finishDrag} onPointerCancel={finishDrag} onLostPointerCapture={finishDrag}
      className="cursor-col-resize bg-transparent shrink-0 relative z-10"
      style={{ width: widthPx }}
    >
      <div
        className="absolute inset-y-0 left-0 right-0"
        onMouseEnter={() => {
          if (lineRef.current) {
            lineRef.current.style.backgroundColor = "var(--node-user)";
            lineRef.current.style.opacity = "0.5";
          }
        }}
        onMouseLeave={() => {
          if (lineRef.current) {
            lineRef.current.style.backgroundColor = "transparent";
            lineRef.current.style.opacity = "1";
          }
        }}
      >
        <div
          ref={lineRef}
          className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150"
        />
      </div>
    </div>
  );
}
