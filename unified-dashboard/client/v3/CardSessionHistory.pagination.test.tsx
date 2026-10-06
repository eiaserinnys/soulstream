/** @vitest-environment jsdom */
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {useDashboardStore,type SessionSummary} from "@seosoyoung/soul-ui";
import type {CardLinkedSession} from "@seosoyoung/soul-ui/cards/card-types";
import {orchestratorSessionProvider} from "../providers";
import {CardSessionHistory} from "./CardSessionHistory";

vi.mock("@seosoyoung/soul-ui",async original=>({...await original<typeof import("@seosoyoung/soul-ui")>(),useSessionMenu:()=>vi.fn()}));
vi.mock("@seosoyoung/soul-ui/cards/CardSessionVirtualList",()=>({CardSessionVirtualList:({data,itemContent,endReached}:any)=><div><button onClick={()=>endReached(data.length-1)}>다음 묶음</button>{data.map((row:any,index:number)=><div key={row.node.session.agentSessionId}>{itemContent(index,row)}</div>)}</div>}));
vi.mock("./SessionRunList",()=>({SessionRunList:({tree}:any)=><>{tree.map((node:any)=><button data-session-id={node.session.agentSessionId} key={node.session.agentSessionId}>{node.session.displayName}</button>)}</>}));
let root:Root,container:HTMLDivElement,client:QueryClient;
const requests:string[][]=[];
let sessions:SessionSummary[]=[];
const summary=(id:string,index:number,parent?:string):SessionSummary=>({agentSessionId:id,displayName:id,callerSessionId:parent,status:"completed",eventCount:1,createdAt:new Date(Date.UTC(2026,0,1,0,index)).toISOString()});
const linked=()=>sessions.map(s=>({sessionId:s.agentSessionId,createdAt:s.createdAt,callerSessionId:s.callerSessionId})) as CardLinkedSession[];
beforeEach(()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 useDashboardStore.setState({catalog:null});requests.length=0;
 container=document.createElement("div");document.body.append(container);root=createRoot(container);
 client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
 vi.spyOn(orchestratorSessionProvider,"fetchSessions").mockImplementation(async options=>{
  const ids=[...options?.sessionIds??[]];requests.push(ids);
  const values=sessions.filter(s=>ids.includes(s.agentSessionId));return {sessions:values,total:values.length,hasMore:false};
 });
});
afterEach(async()=>{await act(()=>root.unmount());container.remove();client.clear();vi.restoreAllMocks();});
async function mount(ids:string[],metadata=linked()){
 await act(()=>root.render(<QueryClientProvider client={client}><CardSessionHistory {...{sessionIds:ids,linkedSessions:metadata}} onOpenSession={()=>{}}/></QueryClientProvider>));
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});
}
async function wait(check:()=>void){await vi.waitFor(async()=>{await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});check();},{timeout:1000,interval:20});}
async function more(){await act(()=>container.querySelector<HTMLButtonElement>("button")!.click());await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});}
const rows=()=>[...container.querySelectorAll("[data-session-id]")].map(node=>node.getAttribute("data-session-id"));
it("continues a 51-ID page containing only children until the last parent arrives",async()=>{
 sessions=[summary("z-parent",0),...Array.from({length:50},(_,i)=>summary(`a-child-${i}`,i+1,"z-parent"))];
 await mount(sessions.map(s=>s.agentSessionId));
 await wait(()=>expect(requests).toHaveLength(2));await wait(()=>expect(rows()).toHaveLength(51));
 expect(rows()[0]).toBe("z-parent");
});
it("advances by processed IDs and stops after inaccessible IDs",async()=>{
 const ids=Array.from({length:70},(_,i)=>`s-${String(i).padStart(3,"0")}`);
 sessions=ids.filter((_,i)=>i!==0&&i!==22).map((id,i)=>summary(id,i));
 await mount(ids);await wait(()=>expect(requests).toHaveLength(1));await more();await wait(()=>expect(requests).toHaveLength(2));
 await more();await more();
 expect(requests.flat()).toHaveLength(70);expect(new Set(requests.flat()).size).toBe(70);expect(requests).toHaveLength(2);
});
it("loads the newest 50 first and appends the older 25 below them",async()=>{
 sessions=Array.from({length:75},(_,i)=>summary(`s-${String(i).padStart(3,"0")}`,i));
 await mount(sessions.map(s=>s.agentSessionId));await wait(()=>expect(rows()).toHaveLength(50));
 expect(rows()[0]).toBe("s-074");expect(requests[0][0]).toBe("s-074");
 const first=rows();await more();await wait(()=>expect(rows()).toHaveLength(75));
 expect(rows().slice(0,50)).toEqual(first);expect(rows().at(-1)).toBe("s-000");
});
it("keeps two inherited child indents on a grandchild",async()=>{
 sessions=[summary("parent",0),summary("child",1,"parent"),summary("grandchild",2,"child")];
 await mount(sessions.map(s=>s.agentSessionId));await wait(()=>expect(rows()).toHaveLength(3));
 let node=container.querySelector('[data-session-id="grandchild"]')!.parentElement,count=0;
 while(node&&node!==container){if(node.classList.contains("v3-run-children"))count++;node=node.parentElement;}
 expect(count).toBe(2);
});
