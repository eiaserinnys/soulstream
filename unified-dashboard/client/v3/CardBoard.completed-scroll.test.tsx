// @vitest-environment jsdom
import {act,forwardRef,useImperativeHandle} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {CardBoardWorkspace} from "./CardBoardWorkspace";
import {reviewCard} from "./components-review-fixtures";
import type {CompletedBrowser} from "./use-completed-cards";

const completedGridHarness=vi.hoisted(()=>({props:null as Record<string,unknown>|null,scrollTo:vi.fn()}));
vi.mock("@seosoyoung/soul-ui/cards/CompletedVirtualGrid",()=>({CompletedVirtualGrid:forwardRef((props:Record<string,unknown>,ref)=>{
 completedGridHarness.props=props;useImperativeHandle(ref,()=>({scrollTo:completedGridHarness.scrollTo}));return null;
})}));

(globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let element:HTMLDivElement,root:Root;
beforeEach(()=>{
 vi.stubGlobal("ResizeObserver",class {observe(){}disconnect(){}});
 element=document.createElement("div");document.body.append(element);root=createRoot(element);
 completedGridHarness.props=null;
 completedGridHarness.scrollTo.mockReset();
});
afterEach(async()=>{await act(()=>root.unmount());element.remove();vi.unstubAllGlobals();});

function makeCompletedBrowser(resetKey:string):CompletedBrowser {
 return {cards:[{...reviewCard,id:"completed",status:"done"}],loading:false,error:null,resetKey,period:"7",setPeriod:vi.fn(),start:"",setStart:vi.fn(),end:"",setEnd:vi.fn(),search:"",setSearch:vi.fn(),loadMore:vi.fn(),retry:vi.fn(),hasMore:false};
}

it("restores the done grid snapshot across expand and collapse and drops it when search resets",async()=>{
 const cards=[reviewCard,{...reviewCard,id:"completed",status:"done" as const}];
 const render=(resetKey:string)=><CardBoardWorkspace title="전체 카드" cards={cards} completed={makeCompletedBrowser(resetKey)} completion={{includeCompleted:true,onChange:vi.fn()}} renderCard={card=><article>{card.title}</article>}/>;
 await act(()=>root.render(render("search-a")));
 const props=()=>completedGridHarness.props!;
 expect(element.querySelectorAll(".v3-completed-controls")).toHaveLength(1);
 const mainSnapshot={scrollTop:312,viewport:{height:400,width:800},item:{height:180,width:256},gap:{row:24,column:24}};
 const expandedSnapshot={...mainSnapshot,scrollTop:940};
 await act(()=>{(props().stateChanged as (state:unknown)=>void)(mainSnapshot);});
 await act(()=>element.querySelector<HTMLButtonElement>('button[aria-label="보드 확대"]')!.click());
 expect(element.querySelectorAll(".v3-completed-controls")).toHaveLength(1);
 expect(props().restoreStateFrom).toEqual({...mainSnapshot,scrollTop:0});
 await act(()=>{(props().stateChanged as (state:unknown)=>void)({...mainSnapshot,scrollTop:0});});
 await act(()=>{(props().readyStateChanged as (ready:boolean)=>void)(true);});
 expect(completedGridHarness.scrollTo).toHaveBeenLastCalledWith({top:312});
 await act(()=>{(props().stateChanged as (state:unknown)=>void)(expandedSnapshot);});
 await act(()=>element.querySelector<HTMLButtonElement>('button[aria-label="확대 닫기"]')!.click());
 expect(props().restoreStateFrom).toEqual({...mainSnapshot,scrollTop:0});
 await act(()=>{(props().stateChanged as (state:unknown)=>void)({...mainSnapshot,scrollTop:0});});
 await act(()=>{(props().readyStateChanged as (ready:boolean)=>void)(true);});
 expect(completedGridHarness.scrollTo).toHaveBeenLastCalledWith({top:312});
 await act(()=>{(props().stateChanged as (state:unknown)=>void)(mainSnapshot);});
 await act(()=>element.querySelector<HTMLButtonElement>('button[aria-label="보드 확대"]')!.click());
 expect(props().restoreStateFrom).toEqual({...mainSnapshot,scrollTop:0});
 await act(()=>{(props().readyStateChanged as (ready:boolean)=>void)(true);});
 expect(completedGridHarness.scrollTo).toHaveBeenLastCalledWith({top:312});
 await act(()=>element.querySelector<HTMLButtonElement>('button[aria-label="확대 닫기"]')!.click());

 await act(()=>root.render(render("search-b")));
 await act(()=>element.querySelector<HTMLButtonElement>('button[aria-label="보드 확대"]')!.click());
 expect(props().restoreStateFrom).toBeUndefined();
});
