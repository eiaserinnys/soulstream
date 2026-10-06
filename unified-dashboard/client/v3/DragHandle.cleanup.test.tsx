/** @vitest-environment jsdom */
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {DragHandle} from "@seosoyoung/soul-ui";
let root:Root,container:HTMLDivElement,handle:HTMLElement;
const dragged=vi.fn();
function pointer(type:string,x=0){const event=new MouseEvent(type,{bubbles:true,clientX:x,button:0});Object.defineProperty(event,"pointerId",{value:1});return event;}
beforeEach(async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;dragged.mockClear();
 Object.defineProperty(document.documentElement,"clientWidth",{configurable:true,value:1000});
 container=document.createElement("div");document.body.append(container);root=createRoot(container);
 await act(()=>root.render(<DragHandle onDrag={dragged}/>));handle=container.firstElementChild as HTMLElement;
 handle.setPointerCapture=vi.fn();handle.hasPointerCapture=()=>true;handle.releasePointerCapture=vi.fn();
});
afterEach(async()=>{document.dispatchEvent(new MouseEvent("mouseup"));await act(()=>root.unmount());container.remove();document.body.style.cursor="";document.body.style.userSelect="";});
async function start(){await act(()=>{handle.dispatchEvent(pointer("pointerdown"));handle.dispatchEvent(new MouseEvent("mousedown",{bubbles:true,clientX:0}));});expect(document.body.style.cursor).toBe("col-resize");}
it.each(["blur","pointercancel","lostpointercapture"])("releases cursor and selection when dragging ends with %s",async type=>{
 await start();await act(()=>type==="blur"?window.dispatchEvent(new Event("blur")):handle.dispatchEvent(pointer(type)));
 expect(document.body.style.cursor).toBe("");expect(document.body.style.userSelect).toBe("");
});
it("removes drag listeners and restores styles when the handle unmounts",async()=>{
 await start();await act(()=>root.render(null));
 expect(document.body.style.cursor).toBe("");expect(document.body.style.userSelect).toBe("");
 document.dispatchEvent(pointer("pointermove",100));document.dispatchEvent(new MouseEvent("mousemove",{clientX:100}));expect(dragged).not.toHaveBeenCalled();
});
it("keeps the normal mouse delta and ends on release",async()=>{
 await start();await act(()=>{handle.dispatchEvent(pointer("pointermove",100));document.dispatchEvent(new MouseEvent("mousemove",{clientX:100}));});
 expect(dragged).toHaveBeenCalledTimes(1);expect(dragged).toHaveBeenCalledWith(10);
 await act(()=>{handle.dispatchEvent(pointer("pointerup",100));document.dispatchEvent(new MouseEvent("mouseup"));});
 expect(document.body.style.cursor).toBe("");expect(document.body.style.userSelect).toBe("");
});
