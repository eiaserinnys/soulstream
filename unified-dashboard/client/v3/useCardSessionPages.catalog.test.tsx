/** @vitest-environment jsdom */
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {useDashboardStore,type CatalogState,type SessionSummary} from "@seosoyoung/soul-ui";
import {orchestratorSessionProvider} from "../providers";
import {useCardSessionPages} from "./useCardSessionPages";
let root:Root,container:HTMLDivElement,client:QueryClient;
let finish:(value:any)=>void,receivedSignal:AbortSignal|undefined;
const fresh:SessionSummary={agentSessionId:"known",displayName:"스트림의 새 이름",status:"running",eventCount:1,createdAt:"2026-10-01"};
const stale:SessionSummary={...fresh,displayName:"옛 이름",status:"completed"};
const unknown:SessionSummary={...fresh,agentSessionId:"unknown",displayName:"새로 찾은 세션"};
const catalog=(values:SessionSummary[]=[])=>({folders:[],sessions:Object.fromEntries(values.map(s=>[s.agentSessionId,{displayName:s.displayName,folderId:null}])),sessionList:values}) as CatalogState;
function Harness({ids}:{ids:string[]}){useCardSessionPages(ids);return null;}
beforeEach(()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;receivedSignal=undefined;finish=undefined!;
 useDashboardStore.setState({catalog:catalog()});
 container=document.createElement("div");document.body.append(container);root=createRoot(container);
 client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
 vi.spyOn(orchestratorSessionProvider,"fetchSessions").mockImplementation(options=>{
  receivedSignal=(options as any)?.signal;return new Promise(resolve=>{finish=resolve;});
 });
});
afterEach(async()=>{await act(()=>root.unmount());client.clear();container.remove();vi.restoreAllMocks();});
async function mount(ids:string[]){await act(()=>root.render(<QueryClientProvider client={client}><Harness ids={ids}/></QueryClientProvider>));await vi.waitFor(()=>expect(finish).toBeTypeOf("function"));}
async function deliver(values:SessionSummary[]){await act(async()=>{finish({sessions:values,total:values.length});await new Promise(resolve=>setTimeout(resolve,0));});}
it("does not merge a late response after unmount and aborts the provider signal",async()=>{
 await mount(["known"]);await act(()=>root.render(null));const current=catalog([fresh]);useDashboardStore.setState({catalog:current});await deliver([stale]);
 expect(useDashboardStore.getState().catalog).toBe(current);expect(receivedSignal?.aborted).toBe(true);
});
it("keeps catalog names and statuses owned by the stream when a mounted request returns old values",async()=>{
 const current=catalog([fresh]);useDashboardStore.setState({catalog:current});await mount(["known"]);await deliver([stale]);expect(useDashboardStore.getState().catalog).toBe(current);
});
it("fills missing sessions without changing existing stream summaries or assignments",async()=>{
 const current=catalog([fresh]);useDashboardStore.setState({catalog:current});await mount(["known","unknown"]);await deliver([stale,unknown]);const saved=useDashboardStore.getState().catalog!;
 expect(saved.sessionList?.find(s=>s.agentSessionId==="known")).toBe(fresh);expect(saved.sessions.known).toBe(current.sessions.known);expect(saved.sessionList?.find(s=>s.agentSessionId==="unknown")).toEqual(unknown);
});
it("fills a session that is absent from the catalog",async()=>{
 await mount(["unknown"]);await deliver([unknown]);expect(useDashboardStore.getState().catalog!.sessionList).toEqual([unknown]);
});
