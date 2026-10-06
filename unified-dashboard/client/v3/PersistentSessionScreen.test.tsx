/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useDashboardStore } from '@seosoyoung/soul-ui/stores/dashboard-store';
import { PersistentSessionScreen } from './PersistentSessionScreen';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ list: vi.fn(), fetchSessions: vi.fn(), provider: vi.fn(), navigate: vi.fn() }));
vi.mock('@seosoyoung/soul-ui', async () => {
 const real = await vi.importActual<typeof import('@seosoyoung/soul-ui')>('@seosoyoung/soul-ui');
 return { ...real, LiquidGlassProvider: ({children}:any) => children, useAuth: () => ({ user:{email:'test@example.com'},refreshAuthStatus:vi.fn() }), useUserPreferencesSync:vi.fn(), useInitialCatalogLoad:vi.fn(), useSessionProvider:(o:any)=> {mocks.provider(o);return {synchronizedSessionKey:o.sessionKey}}, initTheme:vi.fn() };
});
vi.mock('../lib/persistent-sessions',()=>({createPersistentSessionsApi:()=>({list:mocks.list})}));
vi.mock('../providers',()=>({orchestratorSessionProvider:{fetchSessions:mocks.fetchSessions}}));
vi.mock('../dashboard-navigation',()=>({navigateDashboard:(...args:any[])=>mocks.navigate(...args)}));
vi.mock('./use-v3-live-data-plane',()=>({useV3LiveDataPlane:vi.fn()}));
vi.mock('../hooks/useNodes',()=>({useNodes:vi.fn()}));
vi.mock('./use-session-node-connectivity',()=>({useSessionNodeConnectivity:()=>({nodes:new Map([['node-1',{status:'connected'}]])})}));
vi.mock('./V3GlobalToolbar',()=>({V3GlobalToolbar:()=> <header/>}));
vi.mock('../components/ConfigModal',()=>({ConfigModal:(p:any)=>p.open?<div data-testid="config" data-tab={p.initialTab}/>:null}));
vi.mock('./PersistentSessionChatView',()=>({PersistentSessionChatView:(p:any)=><div data-testid="chat" data-session={p.sessionId} data-upload={p.fileUploadUrl} data-history={p.historyEnabled}/> }));
vi.mock('../components/PersistentSessionSettingsDialog',()=>({PersistentSessionSettingsDialog:()=>null}));
let host:HTMLDivElement,root:Root;
const session=(id:string)=>({session_id:id,display_name:id,persistent:true,node_id:'node-1',settings:{default_model:{model_preset:null},show_character:true}});
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();useDashboardStore.getState().setActiveSession(null);host=document.createElement('div');document.body.append(host);root=createRoot(host);mocks.fetchSessions.mockImplementation(async(o:any)=>({sessions:o.sessionIds.map((id:string)=>({agentSessionId:id,nodeId:'node-1',title:id}))}));});
afterEach(()=>{act(()=>root.unmount());host.remove();});
async function mount(id?:string){await act(async()=>{root.render(<PersistentSessionScreen sessionId={id}/>);});}
it('opens the existing add screen for zero PAS without creating a session',async()=>{mocks.list.mockResolvedValue({sessions:[]});await mount();expect(host.querySelector('[data-testid="config"]')?.getAttribute('data-tab')).toBe('persistent');expect(mocks.fetchSessions).not.toHaveBeenCalled();});
it('provides the common frame spacing tokens to reused card components',async()=>{
 mocks.list.mockResolvedValue({sessions:[session('one')]});await mount('one');const frame=host.querySelector<HTMLElement>('[data-testid="persistent-session-screen"]')!;
 expect(frame.style.getPropertyValue('--v3-card-gap')).toBe('4px');expect(frame.style.getPropertyValue('--v3-panel-gap')).toBe('16px');expect(frame.style.getPropertyValue('--v3-outer-inset')).toBe('20px');
});
it('routes one PAS immediately and lets multiple PAS be selected in API order',async()=>{mocks.list.mockResolvedValue({sessions:[session('one')]});await mount();expect(mocks.navigate).toHaveBeenCalledWith('/persistent/one',true);mocks.list.mockResolvedValue({sessions:[session('second'),session('first')]});act(()=>root.unmount());root=createRoot(host);await mount();expect([...host.querySelectorAll('[data-pas-choice]')].map(e=>e.getAttribute('data-pas-choice'))).toEqual(['second','first']);expect(mocks.fetchSessions).not.toHaveBeenCalled();});
it('resolves an explicit PAS before mounting chat and scopes its single stream and uploads',async()=>{mocks.list.mockResolvedValue({sessions:[session('one'),session('two')]});await mount('two');expect(mocks.fetchSessions).toHaveBeenCalledWith({sessionIds:['two']});expect(useDashboardStore.getState().activeSessionKey).toBe('two');expect(host.querySelector('[data-testid="chat"]')?.getAttribute('data-session')).toBe('two');expect(host.querySelector('[data-testid="chat"]')?.getAttribute('data-upload')).toBe('/api/attachments/sessions?nodeId=node-1');expect(mocks.provider.mock.lastCall?.[0]).toMatchObject({sessionKey:'two',active:true,cursorScope:'http://localhost:3000|test@example.com'});expect(host.querySelector('[data-testid="persistent-character"]')).toBeNull();});
it('keeps failed lookup distinct from an empty list and rejects non-PAS addresses',async()=>{mocks.list.mockRejectedValue(new Error('offline'));await mount();expect(host.querySelector('[role="alert"]')?.textContent).toContain('offline');expect(host.querySelector('[data-testid="config"]')).toBeNull();mocks.list.mockResolvedValue({sessions:[session('one')]});await act(async()=>host.querySelector<HTMLButtonElement>('[data-testid="persistent-retry"]')?.click());await mount('ordinary');expect(host.querySelector('[role="alert"]')?.textContent).toContain('영구 세션');expect(host.querySelector('[data-testid="chat"]')).toBeNull();});
vi.mock('./PersistentSessionTaskList',()=>({PersistentSessionTaskList:(p:any)=><button data-testid="scene-card" onClick={()=>p.onOpenCard('card-one')}>작업 카드</button>}));
vi.mock('./CardDetailPane',()=>({CardDetailPane:(p:any)=><div data-testid="scene-summary" data-card={p.cardId}><button onClick={p.onOpenCard}>카드 열기</button></div>}));
vi.mock('./CardWorkspace',()=>({CardWorkspace:(p:any)=><div data-testid="scene-overlay" data-detail-only={p.detailOnly}><button onClick={p.onClose}>카드 닫기</button></div>}));
it('keeps the same chat and selected card summary while hosting the explicit detail-only overlay',async()=>{
 mocks.list.mockResolvedValue({sessions:[session('one')]});await mount('one');const chat=host.querySelector('[data-testid="chat"]');
 await act(()=>host.querySelector<HTMLButtonElement>('[aria-label="작업 목록"]')!.click());await act(()=>host.querySelector<HTMLButtonElement>('[data-testid="scene-card"]')!.click());const summary=host.querySelector('[data-testid="scene-summary"]');
 await act(()=>host.querySelector<HTMLButtonElement>('[data-testid="scene-summary"] button')!.click());expect(host.querySelector('[data-testid="scene-overlay"]')?.getAttribute('data-detail-only')).toBe('true');expect(host.querySelector('[data-testid="chat"]')).toBe(chat);
 await act(()=>host.querySelector<HTMLButtonElement>('[data-testid="scene-overlay"] button')!.click());expect(host.querySelector('[data-testid="scene-summary"]')).toBe(summary);expect(host.querySelector('[data-testid="chat"]')).toBe(chat);expect(useDashboardStore.getState().activeSessionKey).toBe('one');
});
it('clears the PAS tree and settings when changing PAS or leaving its route',async()=>{
 mocks.list.mockResolvedValue({sessions:[session('one'),session('two')]});await mount('one');act(()=>useDashboardStore.setState({tree:{id:'old-pas-tree'} as any,persistentSessionDisplaySettings:{sessionId:'one',showCharacter:true} as any}));await mount('two');expect(useDashboardStore.getState().activeSessionKey).toBe('two');expect(useDashboardStore.getState().tree).toBeNull();expect(useDashboardStore.getState().persistentSessionDisplaySettings).toBeNull();await act(()=>root.render(<div/>));expect(useDashboardStore.getState().activeSessionKey).toBeNull();expect(useDashboardStore.getState().activeSessionSummary).toBeNull();
});
