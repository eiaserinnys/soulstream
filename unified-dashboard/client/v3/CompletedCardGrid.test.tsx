// @vitest-environment jsdom
import {act,forwardRef,useImperativeHandle} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {reviewCard} from "./components-review-fixtures";
import {CompletedCardGrid} from "./CompletedCardGrid";
import type {CompletedGridSnapshot} from "@seosoyoung/soul-ui/cards/CompletedVirtualGrid";
import type {CompletedBrowser} from "./use-completed-cards";

const virtualGridHarness=vi.hoisted(()=>({props:null as Record<string,unknown>|null,scrollTo:vi.fn()}));
vi.mock("@seosoyoung/soul-ui/cards/CompletedVirtualGrid",()=>({CompletedVirtualGrid:forwardRef((props:Record<string,unknown>,ref)=>{
 virtualGridHarness.props=props;useImperativeHandle(ref,()=>({scrollTo:virtualGridHarness.scrollTo}));return null;
})}));

(globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let element:HTMLDivElement,root:Root;
beforeEach(()=>{element=document.createElement("div");document.body.append(element);root=createRoot(element);virtualGridHarness.props=null;virtualGridHarness.scrollTo.mockReset();});
afterEach(async()=>{await act(()=>root.unmount());element.remove();});

it("restores measurements first and applies the saved top once after the public ready event",async()=>{
 const snapshot=Object.freeze({scrollTop:720,viewport:{height:400,width:800},item:{height:180,width:256},gap:{row:24,column:24}}) satisfies CompletedGridSnapshot;
 const changed=vi.fn();
 const browser={cards:[{...reviewCard,id:"done",status:"done"}],loading:false,error:null,resetKey:"period-7",period:"7",setPeriod:vi.fn(),start:"",setStart:vi.fn(),end:"",setEnd:vi.fn(),search:"",setSearch:vi.fn(),loadMore:vi.fn(),retry:vi.fn(),hasMore:false} as CompletedBrowser;
 await act(()=>root.render(<CompletedCardGrid browser={browser} renderCard={()=>null} snapshot={snapshot} onSnapshotChange={changed}/>));
 expect(virtualGridHarness.props?.restoreStateFrom).toEqual({...snapshot,scrollTop:0});
 expect(snapshot.scrollTop).toBe(720);
 expect(virtualGridHarness.scrollTo).not.toHaveBeenCalled();
 const emit=(name:string,value:unknown)=>(virtualGridHarness.props![name] as (value:unknown)=>void)(value);
 await act(()=>emit("stateChanged",{...snapshot,scrollTop:0}));
 expect(changed).not.toHaveBeenCalled();
 virtualGridHarness.scrollTo.mockImplementation(({top}:{top:number})=>emit("stateChanged",{...snapshot,scrollTop:top}));
 await act(()=>emit("readyStateChanged",true));
 expect(virtualGridHarness.scrollTo).toHaveBeenCalledTimes(1);
 expect(virtualGridHarness.scrollTo).toHaveBeenLastCalledWith({top:720});
 expect(changed).toHaveBeenLastCalledWith(snapshot);
 await act(()=>emit("readyStateChanged",true));
 expect(virtualGridHarness.scrollTo).toHaveBeenCalledTimes(1);
 await act(()=>emit("stateChanged",{...snapshot,scrollTop:900}));
 expect(changed).toHaveBeenLastCalledWith({...snapshot,scrollTop:900});
 expect(element.querySelectorAll(".v3-completed-controls")).toHaveLength(1);
 expect(element.querySelector("[data-testid=completed-viewport]")).not.toBeNull();
});
