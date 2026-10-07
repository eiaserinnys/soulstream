/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useDashboardStore } from '@seosoyoung/soul-ui/stores/dashboard-store';
import { useCardStore } from '@seosoyoung/soul-ui/cards/card-store';
import { PersistentSessionScreen } from './PersistentSessionScreen';
import { useCardNavigation } from './card-navigation';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ list: vi.fn(), fetchSessions: vi.fn(), provider: vi.fn(), navigate: vi.fn(), get: vi.fn(), update: vi.fn(), cardRequest: vi.fn() }));
vi.mock('@seosoyoung/soul-ui', async () => {
 const real = await vi.importActual<typeof import('@seosoyoung/soul-ui')>('@seosoyoung/soul-ui');
 return { ...real, LiquidGlassProvider: ({children}:any) => children, useAuth: () => ({ user:{email:'test@example.com'},refreshAuthStatus:vi.fn() }), useUserPreferencesSync:vi.fn(), useInitialCatalogLoad:vi.fn(), useSessionProvider:(o:any)=> {mocks.provider(o);return {synchronizedSessionKey:o.sessionKey}}, initTheme:vi.fn() };
});
vi.mock('../lib/persistent-sessions',()=>({createPersistentSessionsApi:()=>({list:mocks.list,get:mocks.get,update:mocks.update})}));
vi.mock('../providers',()=>({orchestratorSessionProvider:{fetchSessions:mocks.fetchSessions}}));
vi.mock('@seosoyoung/soul-ui/cards/card-api',()=>({cardRequest:mocks.cardRequest}));
vi.mock('../dashboard-navigation',()=>({navigateDashboard:(...args:any[])=>mocks.navigate(...args)}));
vi.mock('./use-v3-live-data-plane',()=>({useV3LiveDataPlane:vi.fn()}));
vi.mock('../hooks/useNodes',()=>({useNodes:vi.fn()}));
vi.mock('./use-session-node-connectivity',()=>({useSessionNodeConnectivity:()=>({nodes:new Map([['node-1',{status:'connected'}]])})}));
vi.mock('./V3GlobalToolbar',()=>({V3GlobalToolbar:(p:any)=> <header><span data-testid="scene-title">{p.sessionName}</span><button onClick={p.onOpenConfig}>PAS 설정</button></header>}));
vi.mock('../components/ConfigModal',()=>({ConfigModal:(p:any)=>p.open?<div data-testid="config" data-tab={p.initialTab}/>:null}));
vi.mock('./PersistentSessionChatView',()=>({PersistentSessionChatView:(p:any)=><div data-testid="chat" data-session={p.sessionId} data-upload={p.fileUploadUrl} data-history={p.historyEnabled}/> }));

let host:HTMLDivElement,root:Root;
const session=(id:string)=>({session_id:id,display_name:id,persistent:true,node_id:'node-1',settings:{default_model:{model_preset:null},show_character:true}});
const currentProviderOptions=()=>mocks.provider.mock.calls.slice(-2).map(([options]:any[])=>options as any);
beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal('matchMedia',(query:string)=>({matches:false,media:query,addEventListener:vi.fn(),removeEventListener:vi.fn()}));localStorage.clear();useDashboardStore.getState().setActiveSession(null);useCardStore.getState().reset();useCardNavigation.getState().close();host=document.createElement('div');document.body.append(host);root=createRoot(host);mocks.fetchSessions.mockImplementation(async(o:any)=>({sessions:o.sessionIds.map((id:string)=>({agentSessionId:id,nodeId:'node-1',title:id}))}));});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.unstubAllGlobals();});
async function mount(id?:string){await act(async()=>{root.render(<PersistentSessionScreen sessionId={id}/>);});}
it('opens the existing add screen for zero PAS without creating a session',async()=>{mocks.list.mockResolvedValue({sessions:[]});await mount();expect(host.querySelector('[data-testid="config"]')?.getAttribute('data-tab')).toBe('persistent');expect(mocks.fetchSessions).not.toHaveBeenCalled();});
it('provides the common frame spacing tokens to reused card components',async()=>{
 mocks.list.mockResolvedValue({sessions:[session('one')]});await mount('one');const frame=host.querySelector<HTMLElement>('[data-testid="persistent-session-screen"]')!;
 expect(frame.style.getPropertyValue('--v3-card-gap')).toBe('4px');expect(frame.style.getPropertyValue('--v3-panel-gap')).toBe('16px');expect(frame.style.getPropertyValue('--v3-outer-inset')).toBe('20px');
});
it('routes one PAS immediately and lets multiple PAS be selected in API order',async()=>{mocks.list.mockResolvedValue({sessions:[session('one')]});await mount();expect(mocks.navigate).toHaveBeenCalledWith('/persistent/one',true);mocks.list.mockResolvedValue({sessions:[session('second'),session('first')]});act(()=>root.unmount());root=createRoot(host);await mount();expect([...host.querySelectorAll('[data-pas-choice]')].map(e=>e.getAttribute('data-pas-choice'))).toEqual(['second','first']);expect(mocks.fetchSessions).not.toHaveBeenCalled();});
it('resolves an explicit PAS before mounting chat and scopes its single stream and uploads',async()=>{mocks.list.mockResolvedValue({sessions:[session('one'),session('two')]});await mount('two');expect(mocks.fetchSessions).toHaveBeenCalledWith({sessionIds:['two']});expect(useDashboardStore.getState().activeSessionKey).toBe('two');expect(host.querySelector('[data-testid="chat"]')?.getAttribute('data-session')).toBe('two');expect(host.querySelector('[data-testid="chat"]')?.getAttribute('data-upload')).toBe('/api/attachments/sessions?nodeId=node-1');expect(currentProviderOptions().find(options=>options.sessionKey==='two')).toMatchObject({sessionKey:'two',active:true,cursorScope:'http://localhost:3000|test@example.com'});expect(host.querySelector('[data-testid="persistent-character"]')).toBeNull();});
it('keeps failed lookup distinct from an empty list and rejects non-PAS addresses',async()=>{mocks.list.mockRejectedValue(new Error('offline'));await mount();expect(host.querySelector('[role="alert"]')?.textContent).toContain('offline');expect(host.querySelector('[data-testid="config"]')).toBeNull();mocks.list.mockResolvedValue({sessions:[session('one')]});await act(async()=>host.querySelector<HTMLButtonElement>('[data-testid="persistent-retry"]')?.click());await mount('ordinary');expect(host.querySelector('[role="alert"]')?.textContent).toContain('영구 세션');expect(host.querySelector('[data-testid="chat"]')).toBeNull();});
vi.mock('./CardDetailPane',()=>({CardDetailPane:(p:any)=><div data-testid="scene-summary" data-card={p.cardId}><button onClick={p.onOpenCard}>카드 열기</button></div>}));
vi.mock('./CardWorkspace',()=>({CardWorkspace:(p:any)=><div data-testid="scene-overlay" data-session={p.activeSession?.agentSessionId??''} data-has-scope={Boolean(p.storeScope)} data-history={p.historyEnabled} data-load-settings={p.loadDisplaySettings} data-mobile-mode={p.mobileMode} data-mobile-tab={p.mobileTab}><button onClick={p.onClose}>카드 닫기</button></div>}));
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
it('uses the existing mobile mode and PAS-local card workspace tab',async()=>{
 vi.stubGlobal('matchMedia',(query:string)=>({matches:query==='(max-width: 760px)',media:query,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
 await openTaskCard('one');const overlay=host.querySelector('[data-testid="scene-overlay"]');
 expect(overlay?.getAttribute('data-mobile-mode')).toBe('true');expect(overlay?.getAttribute('data-mobile-tab')).toBe('today');
 expect(host.querySelector('[aria-label="모바일 화면 탭"]')).not.toBeNull();
});
it('clears the PAS tree and settings when changing PAS or leaving its route',async()=>{
 mocks.list.mockResolvedValue({sessions:[session('one'),session('two')]});await mount('one');act(()=>useDashboardStore.setState({tree:{id:'old-pas-tree'} as any,persistentSessionDisplaySettings:{sessionId:'one',showCharacter:true} as any}));await mount('two');expect(useDashboardStore.getState().activeSessionKey).toBe('two');expect(useDashboardStore.getState().tree).toBeNull();expect(useDashboardStore.getState().persistentSessionDisplaySettings).toBeNull();await act(()=>root.render(<div/>));expect(useDashboardStore.getState().activeSessionKey).toBeNull();expect(useDashboardStore.getState().activeSessionSummary).toBeNull();
});

it('publishes a settings name save to the header without remounting chat',async()=>{
 const resource={...session('one'),display_name:'이전 이름',agent_id:'agent',agent_name:'에이전트',settings:{default_model:{model_preset:'sol',reasoning_effort:'high'},fallback_model:null,show_character:true,animate_character:true,show_generation_separator:true,show_jev_candidates:true,show_turn_usage:true},runtime:{current_model:{model_preset:'sol',reasoning_effort:'high',model:'sol'},pending:null}};
 mocks.list.mockResolvedValue({sessions:[resource]});mocks.get.mockResolvedValue({session:resource});mocks.update.mockImplementation(async(_id:string,patch:any)=>({session:{...resource,display_name:patch.display_name}}));vi.stubGlobal('fetch',vi.fn(async()=>Response.json({messages:[],next_cursor:null,presets:[]})));
 await mount('one');const chat=host.querySelector('[data-testid="chat"]');await act(async()=>[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='PAS 설정')!.click());const input=document.body.querySelector<HTMLInputElement>('input[aria-label="세션 이름"]')!;expect(input).not.toBeNull();await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'새 이름');input.dispatchEvent(new Event('input',{bubbles:true}));});await act(async()=>[...document.body.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='변경 저장')!.click());expect(mocks.update).toHaveBeenCalledWith('one',expect.objectContaining({display_name:'새 이름'}));expect(host.querySelector('[data-testid="scene-title"]')?.textContent).toBe('새 이름');expect(host.querySelector('[data-testid="chat"]')).toBe(chat);expect(mocks.fetchSessions).toHaveBeenCalledOnce();
});
