/** @vitest-environment jsdom */
import {Component, act, type ReactNode} from "react";
import {createRoot,type Root} from "react-dom/client";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,beforeEach,expect,it,vi,type MockInstance} from "vitest";
import {useDashboardStore} from "@seosoyoung/soul-ui";
import {orchestratorSessionProvider} from "../providers";
import {CardSessionHistory} from "./CardSessionHistory";

vi.mock("@seosoyoung/soul-ui",async original=>({...await original<typeof import("@seosoyoung/soul-ui")>(),useSessionMenu:()=>vi.fn()}));
vi.mock("./SessionRunList",()=>({SessionRunList:()=>null}));

class RenderErrorBoundary extends Component<{children:ReactNode},{error:Error|null}> {
 state:{error:Error|null}={error:null};
 static getDerivedStateFromError(error:Error){return {error};}
 componentDidCatch(error:Error){renderError=error;}
 render(){return this.state.error?<div data-render-error>{this.state.error.message}</div>:this.props.children;}
}

let root:Root,container:HTMLDivElement,client:QueryClient,renderError:Error|null;
let fetchSessions:MockInstance<typeof orchestratorSessionProvider.fetchSessions>;

beforeEach(()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 vi.stubGlobal("ResizeObserver",class {observe(){} unobserve(){} disconnect(){}});
 useDashboardStore.setState({catalog:null});
 renderError=null;
 container=document.createElement("div");document.body.append(container);root=createRoot(container);
 client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
 fetchSessions=vi.spyOn(orchestratorSessionProvider,"fetchSessions").mockImplementation(async()=>({sessions:[],total:0,hasMore:false}));
});

afterEach(async()=>{
 await act(()=>root.unmount());container.remove();client.clear();vi.restoreAllMocks();vi.unstubAllGlobals();
});

async function mount(sessionIds:string[]){
 await act(()=>root.render(<QueryClientProvider client={client}><RenderErrorBoundary><CardSessionHistory sessionIds={sessionIds} onOpenSession={()=>{}}/></RenderErrorBoundary></QueryClientProvider>));
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});
}

it("renders a card with no sessions without calling the virtual row key",async()=>{
 await mount([]);

 expect(renderError).toBeNull();
 expect(container.textContent).toContain("아직 세션이 없습니다.");
 expect(fetchSessions).not.toHaveBeenCalled();
});

it("renders while session IDs are still waiting for their first page",async()=>{
 fetchSessions.mockImplementation(()=>new Promise(()=>{}));
 await mount(["s-1"]);

 expect(fetchSessions).toHaveBeenCalled();
 expect(renderError).toBeNull();
});
