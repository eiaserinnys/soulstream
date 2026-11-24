/** @vitest-environment jsdom */
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useDashboardStore } from '@seosoyoung/soul-ui/stores/dashboard-store';
import { useCardStore } from '@seosoyoung/soul-ui/cards/card-store';
import type { UsageSummaryNode, UsageSummaryProvider, UsageSummarySnapshot } from '@seosoyoung/soul-ui';
import { PersistentSessionScreen } from './PersistentSessionScreen';
import { useCardNavigation } from './card-navigation';
import { DashboardInternalLinks } from './DashboardInternalLinks';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ list: vi.fn(), fetchSessions: vi.fn(), provider: vi.fn(), navigate: vi.fn(), get: vi.fn(), update: vi.fn(), bootstrap: vi.fn(), admin: false, cardRequest: vi.fn(), usage: vi.fn(), usageRetry: vi.fn(), sync: true, streamStatus: 'connected', reconnect: vi.fn(), usageSummary: null as UsageSummarySnapshot | null }));
const geometry = vi.hoisted(() => ({ value: null as any }));
vi.mock('./use-persistent-session-geometry',()=>({usePersistentSessionGeometry:()=>geometry.value}));
vi.mock('@seosoyoung/soul-ui', async () => {
 const real = await vi.importActual<typeof import('@seosoyoung/soul-ui')>('@seosoyoung/soul-ui');
 return { ...real, LiquidGlassProvider: ({children}:any) => children, useAuth: () => ({ user:{email:'test@example.com',isAdmin:mocks.admin},refreshAuthStatus:vi.fn() }), useUserPreferencesSync:vi.fn(), useInitialCatalogLoad:vi.fn(), useSessionProvider:(o:any)=> {mocks.provider(o);return {status:mocks.streamStatus,reconnect:mocks.reconnect,synchronizedSessionKey:mocks.sync ? o.sessionKey : null}}, initTheme:vi.fn() };
});
vi.mock('../lib/persistent-sessions',()=>({createPersistentSessionsApi:()=>({list:mocks.list,get:mocks.get,update:mocks.update,bootstrap:mocks.bootstrap})}));
vi.mock('../providers',()=>({orchestratorSessionProvider:{fetchSessions:mocks.fetchSessions}}));
vi.mock('@seosoyoung/soul-ui/cards/card-api',()=>({cardRequest:mocks.cardRequest}));
vi.mock('../dashboard-navigation',()=>({navigateDashboard:(...args:any[])=>mocks.navigate(...args)}));
vi.mock('./use-v3-live-data-plane',()=>({useV3LiveDataPlane:vi.fn()}));
vi.mock('../hooks/useNodes',()=>({useNodes:vi.fn()}));
vi.mock('./use-session-node-connectivity',()=>({useSessionNodeConnectivity:()=>({nodes:new Map([['node-1',{status:'connected'}]])})}));
vi.mock('./V3GlobalToolbar',()=>({V3GlobalToolbar:(p:any)=> <header data-testid="v3-global-toolbar" data-agent-only={String(p.agentOnly)} data-show-home={String(p.showHome!==false)} data-agent-name={p.agentName} data-session-name={p.sessionName}><span data-testid="scene-title">{p.agentName}</span>{p.sessionSwitch}{p.showHome!==false&&<button aria-label="홈" onClick={p.onOpenHome}/>} {p.sessionAction}{p.onToggleUsage&&<button data-testid="usage-toggle" aria-pressed={p.showWeeklyUsage} onClick={p.onToggleUsage}>주간 사용량</button>}<button onClick={p.onOpenConfig}>PAS 설정</button></header>}));
vi.mock('../hooks/useUsageSummary', async()=>{
 const {selectUsageSummaryNode,weeklyUsageGauges}=await vi.importActual<typeof import('@seosoyoung/soul-ui')>('@seosoyoung/soul-ui');
 return {useUsageSummary:(options:any)=>{
  mocks.usage(options);
  const summary=mocks.usageSummary;
  const node=selectUsageSummaryNode(summary,options.nodeId,options.selectedNodeId);
  return {summary,node,gauges:weeklyUsageGauges(node),loading:false,loadState:node?'ready':'idle',evaluatedAtMs:1_800_000_000_000,retry:()=>mocks.usageRetry()};
 }};
});
const savedByConfig=vi.hoisted(()=>({value:null as any}));
vi.mock('../components/ConfigModal',()=>({ConfigModal:(p:any)=>p.open?<div data-testid="config" data-tab={p.initialTab} data-session={p.initialPersistentSessionId??''}><button onClick={()=>p.onPersistentSessionSaved?.(savedByConfig.value)}>설정에서 저장</button><button onClick={()=>p.onOpenChange(false)}>설정 닫기</button></div>:null}));
vi.mock('./PersistentSessionChatView',()=>({PersistentSessionChatView:(p:any)=><div data-testid="chat" data-session={p.sessionId} data-disabled={String(p.chatInputDisabled)} data-settings-lookup={String(p.loadDisplaySettings)} data-report-ready={String(p.reportSeat?.ready)} data-upload={p.fileUploadUrl} data-history={p.historyEnabled} data-runtime-strips={String(p.showRuntimeStrips)}>{JSON.stringify(useDashboardStore.getState().persistentReports[p.sessionId]??[])}{p.transcriptFallback}</div> }));

let host:HTMLDivElement,root:Root;
type MediaListener={query:string;listener:(event:{matches:boolean})=>void};
let mediaListeners:MediaListener[]=[];
const mediaMatches=(query:string)=>{
 if(query==='(min-width: 1101px)')return window.innerWidth>=1101;
 if(query==='(max-width: 767px)')return window.innerWidth<=767;
 if(query==='(max-width: 760px)')return window.innerWidth<=760;
 return false;
};
const resizeTo=(width:number)=>{
 Object.defineProperty(window,'innerWidth',{configurable:true,value:width});
 for(const item of mediaListeners)item.listener({matches:mediaMatches(item.query)});
};
const emptyUsageProvider:UsageSummaryProvider={status:'auto',weeklyRemainingPercent:null,weeklyResetAt:null,shortRemainingPercent:null,shortResetAt:null,quotas:[]};
const usageProvider=(weeklyRemainingPercent:number|null,quotas:UsageSummaryProvider['quotas']=[]):UsageSummaryProvider=>({...emptyUsageProvider,weeklyRemainingPercent,quotas});
const usageNode=(nodeId:string,claude:number|null,codex:number|null,fable=false):UsageSummaryNode=>({
 nodeId,fetchedAt:'2026-10-13T08:00:00.000Z',stale:false,staleSince:null,
 providers:{
  claude:claude!==null||fable?usageProvider(claude,fable?[{id:'claude:weekly_scoped:fable',label:'Fable',window:'7d',model:null,remainingPercent:41,resetAt:1_900_000_000}]:[]):null,
  codex:codex===null?null:usageProvider(codex),

  antigravity:null,
  opencode_go:null,
 },
});
const usageSummaryFixture:UsageSummarySnapshot={generatedAt:'2026-10-13T08:00:00.000Z',collectedAt:null,nodes:[usageNode('node-1',73,38,true),usageNode('node-2',61,42),usageNode('node-3',null,null)]};
const session=(id:string)=>({session_id:id,display_name:id,persistent:true,node_id:'node-1',settings:{default_model:{model_preset:null},show_character:true}});
const currentProviderOptions=()=>mocks.provider.mock.calls.slice(-2).map(([options]:any[])=>options as any);
beforeEach(()=>{vi.clearAllMocks();mocks.sync=true;mocks.streamStatus='connected';resizeTo(1024);mediaListeners=[];vi.stubGlobal('matchMedia',(query:string)=>({get matches(){return mediaMatches(query);},media:query,addEventListener:(_event:string,listener:(event:{matches:boolean})=>void)=>mediaListeners.push({query,listener}),removeEventListener:(_event:string,listener:(event:{matches:boolean})=>void)=>{mediaListeners=mediaListeners.filter(item=>item.listener!==listener);}}));localStorage.clear();mocks.admin=false;mocks.usageSummary=usageSummaryFixture;useDashboardStore.getState().setActiveSession(null);useCardStore.getState().reset();useCardNavigation.getState().close();host=document.createElement('div');document.body.append(host);root=createRoot(host);mocks.fetchSessions.mockImplementation(async(o:any)=>({sessions:o.sessionIds.map((id:string)=>({agentSessionId:id,nodeId:'node-1',title:id}))}));});
afterEach(()=>{act(()=>root.unmount());host.remove();geometry.value=null;vi.unstubAllGlobals();});
async function mount(id?:string){await act(async()=>{root.render(<DashboardInternalLinks><PersistentSessionScreen sessionId={id}/></DashboardInternalLinks>);});}
it('keeps the target frame isolated while list and session summary load in sequence',async()=>{
 const one=session('one'),two=session('two');mocks.list.mockResolvedValue({sessions:[one,two]});await mount('one');
 act(()=>useDashboardStore.setState({tree:{id:'old-tree'} as any,persistentReports:{one:[{title:'old-report'}]} as any}));
 let releaseList!:(value:any)=>void;let releaseSummary!:(value:any)=>void;
 mocks.list.mockReturnValue(new Promise(resolve=>{releaseList=resolve}));
 mocks.fetchSessions.mockReturnValue(new Promise(resolve=>{releaseSummary=resolve}));
 await mount('two');
 const checkWaiting=()=>{
  expect(host.querySelector('[data-testid="chat"]')?.getAttribute('data-session')).toBe('two');
  expect(host.querySelector('[data-testid="chat"]')?.getAttribute('data-disabled')).toBe('true');
  expect(host.querySelector('[data-testid="chat"]')?.getAttribute('data-history')).toBe('false');
  expect(host.querySelector('[data-testid="chat"]')?.textContent).toContain('대화를 불러오는 중');
  expect(host.querySelector('[data-testid="chat"]')?.textContent).not.toContain('old-report');
  expect(useDashboardStore.getState().tree).toBeNull();expect(useDashboardStore.getState().activeSessionSummary).toBeNull();
  expect(useDashboardStore.getState().persistentSessionDisplaySettings?.sessionId).toBe('two');
  expect(currentProviderOptions().some(options=>options.sessionKey==='two'&&options.active)).toBe(false);
 };
 checkWaiting();await act(async()=>releaseList({sessions:[one,two]}));checkWaiting();
 await act(async()=>releaseSummary({sessions:[{agentSessionId:'two',nodeId:'node-1',title:'two'}]}));
 expect(host.querySelector('[data-testid="chat"]')?.getAttribute('data-disabled')).toBe('false');
 expect(currentProviderOptions().some(options=>options.sessionKey==='two'&&options.active)).toBe(true);
});
it('keeps the target frame on summary failure and reconnects after retry',async()=>{
 const one=session('one'),two=session('two');mocks.list.mockResolvedValue({sessions:[one,two]});await mount('one');
 mocks.fetchSessions.mockRejectedValueOnce(new Error('summary offline'));await mount('two');
 expect(host.querySelector('[data-testid="chat"]')?.textContent).toContain('summary offline');
 expect(host.querySelector('[data-testid="chat"]')?.getAttribute('data-disabled')).toBe('true');
 mocks.fetchSessions.mockResolvedValueOnce({sessions:[{agentSessionId:'two',nodeId:'node-1',title:'two'}]});
 await act(async()=>host.querySelector<HTMLButtonElement>('[data-testid="persistent-retry"]')!.click());
 expect(host.querySelector('[data-testid="chat"]')?.getAttribute('data-disabled')).toBe('false');
 expect(useDashboardStore.getState().activeSessionSummary?.agentSessionId).toBe('two');
 expect(currentProviderOptions().some(options=>options.sessionKey==='two'&&options.active)).toBe(true);
});
it('opens the PAS switch before home, marks the current session and navigates to the selected session',async()=>{
 mocks.list.mockResolvedValue({sessions:[session('one'),session('two / 다음')]});await mount('one');
 const home=host.querySelector('[aria-label="홈"]')!;const button=host.querySelector<HTMLButtonElement>('[data-testid="persistent-session-switch"]')!;
 expect(button.nextElementSibling).toBe(home);
 await act(async()=>button.click());
 expect(document.body.querySelector('[data-slot="popover-popup"]')?.classList.contains('v3-popup-chrome')).toBe(true);
 const choice=(title:string)=>[...document.body.querySelectorAll('span')].find(span=>span.textContent===title)?.closest('button');
 const choices=[choice('one'),choice('two / 다음')];
 expect(choices.every(Boolean)).toBe(true);
 expect(choices[0]!.className).toContain('bg-accent-blue/15');expect(choices[1]!.className).not.toContain('bg-accent-blue/15');
 await act(async()=>choices[0]!.click());expect(mocks.navigate).not.toHaveBeenCalled();
 await act(async()=>button.click());await act(async()=>choice('two / 다음')!.click());
 expect(mocks.navigate).toHaveBeenCalledWith('/persistent/two%20%2F%20%EB%8B%A4%EC%9D%8C');
});
it('keeps the usage toggle visible while switching PAS before chat is ready',async()=>{
 resizeTo(1440);mocks.list.mockResolvedValue({sessions:[session('one'),session('two')]});await mount('one');
 expect(host.querySelector('[data-testid="usage-toggle"]')).not.toBeNull();
 mocks.list.mockReturnValue(new Promise(()=>{}));await mount('two');
 expect(host.querySelector('[data-testid="chat"]')?.getAttribute('data-disabled')).toBe('true');
 expect(host.querySelector('[data-testid="usage-toggle"]')).not.toBeNull();
});
it('does not show the PAS switch for a single session',async()=>{
 mocks.list.mockResolvedValue({sessions:[session('one')]});await mount('one');
 expect(host.querySelector('[data-testid="persistent-session-switch"]')).toBeNull();
});
it('opens files in the PAS task seat and restores the task list on close',async()=>{
 mocks.list.mockResolvedValue({sessions:[session('one')]});await mount('one');
 await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="작업 목록"]')!.click());
 const {reviewSessionFiles}=await import('./components-review-fixtures');
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({...reviewSessionFiles,session_id:'one'}),{status:200,headers:{'Content-Type':'application/json'}})));
 const button=host.querySelector<HTMLButtonElement>('[aria-label="세션 파일"]')!;
 await act(async()=>button.click());
 expect(host.querySelector('.v3-session-files-seat .v3-session-files-pane')?.textContent).toContain('outbox_retry.ts');
 await act(async()=>[...host.querySelectorAll<HTMLButtonElement>('.v3-session-files-pane button')].find(b=>b.textContent?.includes('읽기만 한 파일'))!.click());
 expect(host.querySelector('.persistent-session-task-scroll')).toBeNull();
 await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="파일 닫기"]')!.click());
 expect(host.querySelector('.persistent-session-task-scroll')).not.toBeNull();
 await act(async()=>button.click());
 expect([...host.querySelectorAll('.v3-session-files-pane [aria-expanded="true"]')].some(b=>b.textContent?.includes('읽기만 한 파일'))).toBe(true);
});
it('refreshes the open PAS files on a complete event from the global session store',async()=>{
 mocks.list.mockResolvedValue({sessions:[session('one')]});await mount('one');
 const {reviewSessionFiles}=await import('./components-review-fixtures');
 const request=vi.fn(async()=>new Response(JSON.stringify({...reviewSessionFiles,session_id:'one'}),{status:200,headers:{'Content-Type':'application/json'}}));
 vi.stubGlobal('fetch',request);
 await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="세션 파일"]')!.click());
 expect(request).toHaveBeenCalledTimes(1);
 await act(async()=>useDashboardStore.getState().processEvent({type:'complete',result:'끝',attachments:[]} as any,190));
 expect(request).toHaveBeenCalledTimes(2);
});
it('seeds the active display settings from its PAS list before opening chat',async()=>{
 mocks.list.mockResolvedValue({sessions:[session('one'),session('two')]});await mount('two');
 expect(useDashboardStore.getState().persistentSessionDisplaySettings).toMatchObject({sessionId:'two',showCharacter:true});
});
it('provides measured report geometry while the chat view owns settings readiness',async()=>{
 geometry.value={reportBubble:null,body:null,toggle:null,lineY:0,lineLeftReach:0};
 useDashboardStore.getState().setPersistentSessionDisplaySettings('one',null);
 mocks.list.mockResolvedValue({sessions:[session('one')]});await mount('one');
 const chat=()=>host.querySelector('[data-testid="chat"]')!;
 expect(chat().getAttribute('data-report-ready')).toBe('true');
 act(()=>useDashboardStore.getState().setPersistentSessionDisplaySettings('one',{show_generation_separator:true,show_jev_candidates:true,show_character:false,animate_character:false,turn_usage_mode:'collapsed'}));
 expect(chat().getAttribute('data-report-ready')).toBe('true');
});
const emptyListing=(defaults:Record<string,unknown>={})=>({sessions:[],total:0,create_defaults:{node_id:'node-1',preferred_agent_id:'agent',initial_instruction:'',unavailable_reason:null,...defaults}});
const text=()=>host.textContent??'';
const press=async(label:string)=>{await act(async()=>[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label)!.click());};
it('draws the manual empty state for zero PAS without bootstrap and opens the create form in settings',async()=>{
 mocks.list.mockResolvedValue(emptyListing());await mount();
 expect(text()).toContain('영구 세션이 없습니다');expect(mocks.bootstrap).not.toHaveBeenCalled();expect(mocks.fetchSessions).not.toHaveBeenCalled();expect(host.querySelector('[data-testid="config"]')).toBeNull();
 await press('영구 세션 만들기');
 expect(host.querySelector('[data-testid="config"]')?.getAttribute('data-tab')).toBe('persistent');expect(host.querySelector('[data-testid="config"]')?.getAttribute('data-session')).toBe('');
 mocks.list.mockResolvedValue({sessions:[session('made'),session('other')],total:2,create_defaults:emptyListing().create_defaults});
 await press('설정 닫기');
 expect(host.querySelector('[data-testid="config"]')).toBeNull();expect(mocks.navigate).toHaveBeenCalledWith('/persistent/made',true);
});
it('bootstraps the default PAS exactly once under StrictMode and replaces the route on success',async()=>{
 mocks.list.mockResolvedValue(emptyListing({bootstrap_enabled:true}));mocks.bootstrap.mockResolvedValue({created:true,session_id:'new one'});
 await act(async()=>{root.render(<StrictMode><DashboardInternalLinks><PersistentSessionScreen/></DashboardInternalLinks></StrictMode>);});
 expect(mocks.bootstrap).toHaveBeenCalledTimes(1);expect(mocks.navigate).toHaveBeenCalledWith('/persistent/new%20one',true);
});
it('shows the creating state while bootstrap is pending',async()=>{
 mocks.list.mockResolvedValue(emptyListing({bootstrap_enabled:true}));mocks.bootstrap.mockReturnValue(new Promise(()=>undefined));await mount();
 expect(host.querySelector('[data-testid="persistent-empty-creating"]')?.textContent).toContain('기본 영구 세션을 만드는 중입니다');expect(mocks.navigate).not.toHaveBeenCalled();
});
it('keeps a failed bootstrap on the screen and retries it with the retry button',async()=>{
 mocks.list.mockResolvedValue(emptyListing({bootstrap_enabled:true}));mocks.bootstrap.mockRejectedValueOnce(new Error('서버가 거절했습니다'));await mount();
 expect(text()).toContain('서버가 거절했습니다');expect(mocks.navigate).not.toHaveBeenCalled();expect(mocks.bootstrap).toHaveBeenCalledTimes(1);
 mocks.bootstrap.mockResolvedValueOnce({created:true,session_id:'retried'});await press('다시 시도');
 expect(mocks.bootstrap).toHaveBeenCalledTimes(2);expect(mocks.navigate).toHaveBeenCalledWith('/persistent/retried',true);
});
it('asks admins to connect a coding agent when bootstrap is on but unavailable, and re-reads after the settings close',async()=>{
 mocks.admin=true;mocks.list.mockResolvedValue(emptyListing({bootstrap_enabled:true,unavailable_reason:'쓸 수 있는 모델이 없습니다.'}));await mount();
 expect(text()).toContain('코딩 에이전트를 연결하면 기본 영구 세션을 만듭니다');expect(text()).toContain('쓸 수 있는 모델이 없습니다.');expect(mocks.bootstrap).not.toHaveBeenCalled();
 await press('코딩 에이전트 연결');
 expect(host.querySelector('[data-testid="config"]')?.getAttribute('data-tab')).toBe('coding_agents');
 mocks.list.mockResolvedValue(emptyListing({bootstrap_enabled:true,unavailable_reason:null}));mocks.bootstrap.mockResolvedValue({created:true,session_id:'ready'});
 const before=mocks.list.mock.calls.length;await press('설정 닫기');
 expect(mocks.list.mock.calls.length).toBe(before+1);expect(mocks.bootstrap).toHaveBeenCalledTimes(1);expect(mocks.navigate).toHaveBeenCalledWith('/persistent/ready',true);
});
it('hides the connect button from non-admins in the unavailable state',async()=>{
 mocks.list.mockResolvedValue(emptyListing({bootstrap_enabled:true,unavailable_reason:'쓸 수 있는 모델이 없습니다.'}));await mount();
 expect(text()).toContain('쓸 수 있는 모델이 없습니다.');expect([...host.querySelectorAll('button')].some(b=>b.textContent==='코딩 에이전트 연결')).toBe(false);
});
it('opens the persistent settings tab with the viewed PAS selected and stays on the PAS window when it closes',async()=>{
 const resource=session('one');mocks.list.mockResolvedValue({sessions:[resource,session('two')]});await mount('one');
 const chat=host.querySelector('[data-testid="chat"]');
 await press('PAS 설정');
 expect(host.querySelector('[data-testid="config"]')?.getAttribute('data-tab')).toBe('persistent');expect(host.querySelector('[data-testid="config"]')?.getAttribute('data-session')).toBe('one');
 const calls=mocks.list.mock.calls.length;await press('설정 닫기');
 expect(host.querySelector('[data-testid="config"]')).toBeNull();expect(mocks.navigate).not.toHaveBeenCalled();expect(mocks.list.mock.calls.length).toBe(calls);expect(host.querySelector('[data-testid="chat"]')).toBe(chat);
});
it('provides the common frame spacing tokens to reused card components',async()=>{
 mocks.list.mockResolvedValue({sessions:[session('one')]});await mount('one');const frame=host.querySelector<HTMLElement>('[data-testid="persistent-session-screen"]')!;
 expect(frame.style.getPropertyValue('--v3-card-gap')).toBe('4px');expect(frame.style.getPropertyValue('--v3-panel-gap')).toBe('16px');expect(frame.style.getPropertyValue('--v3-outer-inset')).toBe('20px');
});
it('routes one PAS immediately and lets multiple PAS be selected in API order',async()=>{mocks.list.mockResolvedValue({sessions:[session('one')]});await mount();expect(mocks.navigate).toHaveBeenCalledWith('/persistent/one',true);mocks.list.mockResolvedValue({sessions:[session('second'),session('first')]});act(()=>root.unmount());root=createRoot(host);await mount();expect([...host.querySelectorAll('[data-pas-choice]')].map(e=>e.getAttribute('data-pas-choice'))).toEqual(['second','first']);expect(host.querySelector('[data-testid="persistent-session-switch"]')).toBeNull();expect(mocks.fetchSessions).not.toHaveBeenCalled();});
it('resolves an explicit PAS before mounting chat and scopes its single stream and uploads',async()=>{mocks.list.mockResolvedValue({sessions:[session('one'),session('two')]});await mount('two');expect(mocks.fetchSessions).toHaveBeenCalledWith({sessionIds:['two']});expect(useDashboardStore.getState().activeSessionKey).toBe('two');expect(host.querySelector('[data-testid="chat"]')?.getAttribute('data-session')).toBe('two');expect(host.querySelector('[data-testid="chat"]')?.getAttribute('data-upload')).toBe('/api/attachments/sessions?nodeId=node-1');expect(currentProviderOptions().find(options=>options.sessionKey==='two')).toMatchObject({sessionKey:'two',active:true,cursorScope:'http://localhost:3000|test@example.com'});expect(host.querySelector('[data-testid="persistent-character"]')).toBeNull();});
it('uses the agent-only toolbar, keeps the home button reachable, and hides runtime strips on mobile PAS while keeping the conversation mounted',async()=>{
 Object.defineProperty(window,'innerWidth',{configurable:true,value:390});
 mocks.list.mockResolvedValue({sessions:[{...session('one'),display_name:'세션 제목',agent_name:'로젤린'}]});
 await mount('one');
 const toolbar=host.querySelector('[data-testid="v3-global-toolbar"]');
 expect(toolbar?.getAttribute('data-agent-only')).toBe('true');
 expect(toolbar?.getAttribute('data-show-home')).toBe('true');
 expect(toolbar?.getAttribute('data-agent-name')).toBe('로젤린');
 await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="홈"]')!.click());
 expect(mocks.navigate).toHaveBeenCalledWith('/');
 expect(host.querySelector('[data-testid="scene-title"]')?.textContent).toBe('로젤린');
 expect(host.querySelector('[data-testid="chat"]')?.getAttribute('data-runtime-strips')).toBe('false');
});
it('persists the weekly usage toggle and selected node, pauses below 1101px, and resumes without replacing chat',async()=>{
 resizeTo(1440);
 mocks.list.mockResolvedValue({sessions:[session('one')]});
 mocks.cardRequest.mockResolvedValue({cards:[]});
 await mount('one');
 const chat=host.querySelector('[data-testid="chat"]');
 const getToggle=()=>host.querySelector<HTMLButtonElement>('[data-testid="usage-toggle"]')!;
 const toggle=getToggle();
 expect(toggle.getAttribute('aria-pressed')).toBe('false');
 expect(mocks.usage.mock.calls.at(-1)?.[0]).toMatchObject({enabled:false,nodeId:'node-1',selectedNodeId:null});
 await act(async()=>getToggle().click());
 expect(localStorage.getItem('soulstream-pas-device:test@example.com')).toContain('"showWeeklyUsage":true');
 expect(mocks.usage.mock.calls.at(-1)?.[0]).toMatchObject({enabled:true,nodeId:'node-1',selectedNodeId:null});
 const readout=host.querySelector('[data-testid="persistent-session-weekly-usage"]');
 expect(readout?.textContent).toContain('Claude');
 await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="노드 바꾸기, 현재 node-1"]')!.click());
 expect(JSON.parse(localStorage.getItem('soulstream-pas-device:test@example.com')!).weeklyUsageNodeSelection).toEqual({configuredNodeId:'node-1',selectedNodeId:'node-2'});
 expect(mocks.usage.mock.calls.at(-1)?.[0]).toMatchObject({enabled:true,selectedNodeId:'node-2'});
 expect(host.querySelector('[aria-label="노드 바꾸기, 현재 node-2"]')).not.toBeNull();
 await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="작업 목록"]')!.click());
 expect(host.querySelector('.persistent-session-tasks')!.compareDocumentPosition(readout!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
 expect(host.querySelector('[data-testid="persistent-session-weekly-usage"]')).toBe(readout);
 expect(host.querySelector('[data-testid="chat"]')).toBe(chat);
 await act(async()=>getToggle().click());
 expect(host.querySelector('[data-testid="persistent-session-weekly-usage"]')).toBeNull();
 await act(async()=>getToggle().click());
 expect(host.querySelector('[data-testid="persistent-session-weekly-usage"]')).not.toBeNull();
 expect(mocks.usage.mock.calls.at(-1)?.[0]).toMatchObject({enabled:true,selectedNodeId:'node-2'});
 await act(async()=>{resizeTo(1100);});
 expect(mocks.usage.mock.calls.at(-1)?.[0]).toMatchObject({enabled:false,selectedNodeId:'node-2'});
 expect(JSON.parse(localStorage.getItem('soulstream-pas-device:test@example.com')!).weeklyUsageNodeSelection).toEqual({configuredNodeId:'node-1',selectedNodeId:'node-2'});
 await act(async()=>{resizeTo(1101);});
 expect(mocks.usage.mock.calls.at(-1)?.[0]).toMatchObject({enabled:true,selectedNodeId:'node-2'});
 act(()=>root.unmount());root=createRoot(host);await mount('one');
 expect(getToggle().getAttribute('aria-pressed')).toBe('true');
 expect(mocks.usage.mock.calls.at(-1)?.[0]).toMatchObject({enabled:true,selectedNodeId:'node-2'});
 expect(host.querySelector('[data-testid="persistent-session-weekly-usage"]')).not.toBeNull();
});
it('keeps failed lookup distinct from an empty list and rejects non-PAS addresses',async()=>{mocks.list.mockRejectedValue(new Error('offline'));await mount();expect(host.querySelector('[role="alert"]')?.textContent).toContain('offline');expect(host.querySelector('[data-testid="config"]')).toBeNull();mocks.list.mockResolvedValue({sessions:[session('one')]});await act(async()=>host.querySelector<HTMLButtonElement>('[data-testid="persistent-retry"]')?.click());await mount('ordinary');expect(host.querySelector('[role="alert"]')?.textContent).toContain('영구 세션');expect(host.querySelector('[data-testid="chat"]')).toBeNull();});
vi.mock('./CardDetailPane',()=>({CardDetailPane:(p:any)=><div data-testid="scene-summary" data-card={p.cardId}><button onClick={p.onOpenCard}>카드 열기</button></div>}));
vi.mock('./CardWorkspace',()=>({CardWorkspace:(p:any)=><div data-testid="scene-overlay" data-session={p.activeSession?.agentSessionId??''} data-has-scope={Boolean(p.storeScope)} data-history={p.historyEnabled} data-load-settings={p.loadDisplaySettings} data-mobile-mode={p.mobileMode} data-mobile-tab={p.mobileTab}><button onClick={p.onClose}>카드 닫기</button><button onClick={()=>p.onOpenSession({agentSessionId:'assigned',nodeId:'node-1',title:'담당 세션'},{source:'user'})}>담당 세션 선택</button><button onClick={p.onCloseChat}>채팅 닫기</button></div>}));
const taskCard=(assigneeSessionId:string|null)=>({id:'card-one',number:1,title:'작업 카드',status:'running',version:1,positionKey:'a',assigneeKind:assigneeSessionId?'session':null,assigneeSessionId,assigneeAgentId:assigneeSessionId?'agent-1':null,nodeId:assigneeSessionId?'node-1':null});
async function openTaskCard(assigneeSessionId:string|null){
 mocks.list.mockResolvedValue({sessions:[session('one')]});mocks.cardRequest.mockResolvedValue({cards:[taskCard(assigneeSessionId)]});await mount('one');const chat=host.querySelector('[data-testid="chat"]');
 await act(async()=>{host.querySelector<HTMLButtonElement>('[aria-label="작업 목록"]')!.click();await new Promise(resolve=>setTimeout(resolve,0));});const taskScroll=host.querySelector<HTMLElement>('.persistent-session-task-scroll')!;const taskButton=host.querySelector('[data-card-id="card-one"]');expect(taskButton).not.toBeNull();taskScroll.scrollTop=87;
 await act(async()=>{host.querySelector<HTMLButtonElement>('[data-card-id="card-one"]')!.click();await new Promise(resolve=>setTimeout(resolve,0));});return {chat,taskScroll,taskButton};
}
it('opens the main two-column card workspace directly and keeps the PAS transcript mounted',async()=>{
 useCardNavigation.getState().open('main-view-card','overlay',null,'main-view-session');
 const {chat,taskScroll,taskButton}=await openTaskCard('one');const overlay=host.querySelector('[data-testid="scene-overlay"]');
 expect(useCardNavigation.getState()).toMatchObject({cardId:'main-view-card',initialSessionId:'main-view-session'});
 expect(host.querySelector('[data-testid="scene-summary"]')).toBeNull();expect(overlay?.getAttribute('data-session')).toBe('one');expect(overlay?.getAttribute('data-has-scope')).toBe('false');expect(overlay?.getAttribute('data-history')).toBe('false');expect(overlay?.getAttribute('data-load-settings')).toBe('false');
 expect(host.querySelector('.persistent-session-task-scroll')).toBe(taskScroll);expect(taskScroll.hidden).toBe(true);expect(host.querySelector('[data-card-id="card-one"]')).toBe(taskButton);expect(taskScroll.scrollTop).toBe(87);expect(mocks.cardRequest).toHaveBeenCalledTimes(1);expect(mocks.cardRequest).toHaveBeenCalledWith('/api/cards?includeCompleted=false');
 expect(currentProviderOptions().filter(options=>options.active)).toHaveLength(1);const activeProvider=currentProviderOptions().find(options=>options.active);expect(activeProvider).toMatchObject({sessionKey:'one'});expect(activeProvider).not.toHaveProperty('store');expect(useDashboardStore.getState().activeSessionKey).toBe('one');
 await act(()=>host.querySelector<HTMLButtonElement>('[data-testid="scene-overlay"] button')!.click());expect(host.querySelector('[data-testid="scene-overlay"]')).toBeNull();expect(host.querySelector('[data-testid="scene-summary"]')).toBeNull();expect(taskScroll.hidden).toBe(false);expect(host.querySelector('[data-card-id="card-one"]')).toBe(taskButton);expect(taskScroll.scrollTop).toBe(87);expect(host.querySelector('[data-testid="chat"]')).toBe(chat);expect(useDashboardStore.getState().activeSessionKey).toBe('one');expect(useCardNavigation.getState()).toMatchObject({cardId:'main-view-card',initialSessionId:'main-view-session'});expect(mocks.cardRequest).toHaveBeenCalledTimes(1);
});
it('scopes a different assigned session to the overlay without changing the PAS selection',async()=>{
 const {chat}=await openTaskCard('assigned');const overlay=host.querySelector('[data-testid="scene-overlay"]');
 expect(overlay?.getAttribute('data-session')).toBe('assigned');expect(overlay?.getAttribute('data-has-scope')).toBe('true');expect(mocks.fetchSessions).toHaveBeenCalledWith({sessionIds:['assigned']});expect(currentProviderOptions().find(options=>options.active&&options.sessionKey==='assigned')?.store).toBeDefined();expect(host.querySelector('[data-testid="chat"]')).toBe(chat);expect(useDashboardStore.getState().activeSessionKey).toBe('one');
});
it('shows the card workspace empty state when a card has no assigned session',async()=>{
 const {chat}=await openTaskCard(null);const overlay=host.querySelector('[data-testid="scene-overlay"]');
 expect(overlay?.getAttribute('data-session')).toBe('');expect(overlay?.getAttribute('data-has-scope')).toBe('false');expect(host.querySelector('[data-testid="chat"]')).toBe(chat);expect(useDashboardStore.getState().activeSessionKey).toBe('one');
});
it('uses the phone card session flow and returns to the same detail without changing PAS',async()=>{
 vi.stubGlobal('matchMedia',(query:string)=>({matches:query==='(max-width: 760px)',media:query,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
 const {chat,taskScroll}=await openTaskCard('assigned');const overlay=host.querySelector('[data-testid="scene-overlay"]');
 expect(overlay?.getAttribute('data-mobile-mode')).toBe('true');expect(overlay?.getAttribute('data-mobile-tab')).toBe('today');
 expect(host.querySelector('[aria-label="모바일 화면 탭"]')).toBeNull();
 await act(async()=>[...overlay!.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='담당 세션 선택')!.click());
 expect(overlay?.getAttribute('data-mobile-tab')).toBe('chat');expect(useDashboardStore.getState().activeSessionKey).toBe('one');
 await act(()=>[...overlay!.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='채팅 닫기')!.click());
 expect(host.querySelector('[data-testid="scene-overlay"]')).toBe(overlay);expect(overlay?.getAttribute('data-mobile-tab')).toBe('today');
 await act(()=>[...overlay!.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='카드 닫기')!.click());
 expect(host.querySelector('[data-testid="scene-overlay"]')).toBeNull();expect(host.querySelector('[data-testid="chat"]')).toBe(chat);expect(taskScroll.scrollTop).toBe(87);expect(useDashboardStore.getState().activeSessionKey).toBe('one');
});
it('clears the PAS tree and settings when changing PAS or leaving its route',async()=>{
 mocks.list.mockResolvedValue({sessions:[session('one'),session('two')]});await mount('one');act(()=>useDashboardStore.setState({tree:{id:'old-pas-tree'} as any,persistentSessionDisplaySettings:{sessionId:'one',showCharacter:true} as any}));await mount('two');expect(useDashboardStore.getState().activeSessionKey).toBe('two');expect(useDashboardStore.getState().tree).toBeNull();expect(useDashboardStore.getState().persistentSessionDisplaySettings).toMatchObject({sessionId:'two',showCharacter:true});await act(()=>root.render(<div/>));expect(useDashboardStore.getState().persistentSessionDisplaySettings).toBeNull();expect(useDashboardStore.getState().activeSessionKey).toBeNull();expect(useDashboardStore.getState().activeSessionSummary).toBeNull();
});

it('shows the display name saved in the settings window without re-reading and keeps the actual agent name in the header',async()=>{
 Object.defineProperty(window,'innerWidth',{configurable:true,value:1440});
 const resource={...session('one'),display_name:'이전 이름',agent_id:'agent',agent_name:'에이전트',settings:{default_model:{model_preset:'sol',reasoning_effort:'high'},fallback_models:[],show_character:true,animate_character:true,show_generation_separator:true,show_jev_candidates:true,turn_usage_mode:'collapsed' as const,show_turn_usage:true},runtime:{current_model:{model_preset:'sol',reasoning_effort:'high',model:'sol'},pending:null}};
 mocks.list.mockResolvedValue({sessions:[resource]});vi.stubGlobal('fetch',vi.fn(async()=>Response.json({messages:[],next_cursor:null,presets:[]})));
 await mount('one');const chat=host.querySelector('[data-testid="chat"]');const bar=()=>host.querySelector('[data-testid="v3-global-toolbar"]');
 expect(bar()?.getAttribute('data-agent-only')).toBe('false');expect(bar()?.getAttribute('data-show-home')).toBe('true');expect(bar()?.getAttribute('data-session-name')).toBe('이전 이름');expect(host.querySelector('[data-testid="scene-title"]')?.textContent).toBe('에이전트');
 await press('PAS 설정');
 savedByConfig.value={...resource,display_name:'새 이름',settings:{...resource.settings,show_character:false}};
 const listCalls=mocks.list.mock.calls.length;await press('설정에서 저장');
 expect(bar()?.getAttribute('data-session-name')).toBe('새 이름');expect(host.querySelector('[data-testid="scene-title"]')?.textContent).toBe('에이전트');
 expect(useDashboardStore.getState().persistentSessionDisplaySettings).toMatchObject({sessionId:'one',showCharacter:false});
 expect(mocks.list.mock.calls.length).toBe(listCalls);expect(host.querySelector('[data-testid="chat"]')).toBe(chat);expect(mocks.fetchSessions).toHaveBeenCalledOnce();expect(mocks.navigate).not.toHaveBeenCalled();
});

it('omits weekly usage on the unselected wide PAS route',async()=>{
 resizeTo(1440);mocks.list.mockResolvedValue({sessions:[session('one')]});await mount();
 expect(host.querySelector('[data-testid="usage-toggle"]')).toBeNull();
});
it('keeps transcript loading until the target subscription synchronizes',async()=>{
 mocks.list.mockResolvedValue({sessions:[session('one')]});mocks.sync=false;await mount('one');
 expect(host.querySelector('[data-testid="chat"]')?.textContent).toContain('대화를 불러오는 중');
 expect(host.querySelector('[data-testid="chat"]')?.getAttribute('data-history')).toBe('false');
 mocks.sync=true;await mount('one');
 expect(host.querySelector('[data-testid="chat"]')?.textContent).not.toContain('대화를 불러오는 중');
 expect(host.querySelector('[data-testid="chat"]')?.getAttribute('data-history')).toBe('true');
});

it('holds the stream error through automatic retries until sync or manual reconnect',async()=>{
 mocks.list.mockResolvedValue({sessions:[session('one'),session('two')]});mocks.sync=false;mocks.streamStatus='error';await mount('one');
 const retry=()=>host.querySelector<HTMLButtonElement>('[data-testid="v3-session-stream-retry"]');
 expect(retry()).not.toBeNull();
 for(const status of ['connecting','connected','error','connecting']){
  mocks.streamStatus=status;await mount('one');expect(retry()).not.toBeNull();
  expect(host.querySelector('[data-testid="chat"]')?.textContent).not.toContain('대화를 불러오는 중');
 }
 mocks.sync=true;mocks.streamStatus='connected';await mount('one');
 expect(retry()).toBeNull();expect(host.querySelector('[data-testid="chat"]')?.getAttribute('data-history')).toBe('true');
 mocks.sync=false;mocks.streamStatus='error';await mount('one');expect(retry()).not.toBeNull();
 await act(async()=>retry()!.click());expect(mocks.reconnect).toHaveBeenCalledOnce();
 // reconnect updates the hook status after this render; its old error must not flash back.
 expect(retry()).toBeNull();expect(host.querySelector('[data-testid="chat"]')?.textContent).toContain('대화를 불러오는 중');
 mocks.streamStatus='connecting';await mount('one');expect(retry()).toBeNull();
 mocks.streamStatus='error';await mount('one');expect(retry()).not.toBeNull();
 mocks.streamStatus='connecting';await mount('two');expect(retry()).toBeNull();
});

const reportEntry=(key:string)=>({key,kind:'ask' as const,title:'질문',card_numbers:[1268],context:'맥락',action:'답해 주세요',options:[] as string[],state:'open' as const,answer:'',updated_at:'2026-11-12T00:00:00.000Z'});
it('re-reads the current report when the tab becomes visible again',async()=>{
 const one=session('one');mocks.list.mockResolvedValue({sessions:[one]});await mount('one');
 act(()=>useDashboardStore.getState().setPersistentReport('one',[reportEntry('cq_X')]));
 mocks.list.mockResolvedValue({sessions:[{...one,persistent_report:[]}]});
 await act(async()=>{document.dispatchEvent(new Event('visibilitychange'));await new Promise(resolve=>setTimeout(resolve,0));});
 expect(useDashboardStore.getState().persistentReports.one).toEqual([]);
});
it('keeps a report that changed while the visible refetch was pending',async()=>{
 const one=session('one');mocks.list.mockResolvedValue({sessions:[one]});await mount('one');
 act(()=>useDashboardStore.getState().setPersistentReport('one',[reportEntry('cq_X')]));
 let release!:(value:any)=>void;
 mocks.list.mockReturnValue(new Promise(resolve=>{release=resolve;}));
 await act(async()=>{document.dispatchEvent(new Event('visibilitychange'));await new Promise(resolve=>setTimeout(resolve,0));});
 act(()=>useDashboardStore.getState().setPersistentReport('one',[reportEntry('cq_Y')]));
 await act(async()=>{release({sessions:[{...one,persistent_report:[]}]});await new Promise(resolve=>setTimeout(resolve,0));});
 expect(useDashboardStore.getState().persistentReports.one).toMatchObject([{key:'cq_Y'}]);
});
