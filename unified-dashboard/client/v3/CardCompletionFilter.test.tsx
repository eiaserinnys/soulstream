// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {CardCompletionFilter} from "./CardCompletionFilter";

(globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let element:HTMLDivElement,root:Root;
beforeEach(()=>{vi.stubGlobal("PointerEvent",MouseEvent);element=document.createElement("div");document.body.append(element);root=createRoot(element);});
afterEach(async()=>{await act(()=>root.unmount());element.remove();vi.unstubAllGlobals();});

it("names the completion switch once and hides the visible copy from the accessibility tree",async()=>{
 const onChange=vi.fn();
 await act(()=>root.render(<CardCompletionFilter includeCompleted={false} onChange={onChange}/>));
 const switches=element.querySelectorAll('[role="switch"]');
 expect(switches).toHaveLength(1);
 const toggle=switches[0] as HTMLElement;
 expect(toggle.getAttribute("aria-label")).toBe("완료·취소 숨김");
 expect(toggle.getAttribute("aria-checked")).toBe("true");
 const visible=[...element.querySelectorAll(".v3-card-completion-filter label > span")].filter(node=>node.textContent==="완료·취소 숨김");
 expect(visible).toHaveLength(1);
 expect(visible[0].getAttribute("aria-hidden")).toBe("true");
 expect(visible[0].textContent).toBe("완료·취소 숨김");
 await act(()=>{(visible[0] as HTMLElement).click();});
 expect(onChange).toHaveBeenCalledWith(true);
});
