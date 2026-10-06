/** @vitest-environment jsdom */
import { act } from 'react';import { createRoot } from 'react-dom/client';import { afterEach,expect,it,vi } from 'vitest';
import { PersistentSessionEntry } from './PersistentSessionEntry';
import { V3GlobalToolbar } from './V3GlobalToolbar';
const mocks=vi.hoisted(()=>({list:vi.fn(),navigate:vi.fn(),create:vi.fn()}));
vi.mock('@seosoyoung/soul-ui',async()=>({...await vi.importActual<any>('@seosoyoung/soul-ui'),useAuth:()=>({user:{email:'entry@example.com'}})}));
vi.mock('../lib/persistent-sessions',()=>({createPersistentSessionsApi:()=>({list:mocks.list})}));
vi.mock('../dashboard-navigation',()=>({navigateDashboard:(...a:any[])=>mocks.navigate(...a)}));
vi.mock('../components/ConfigModal',()=>({ConfigModal:(p:any)=>p.open?<div data-testid="entry-config"><button onClick={()=>mocks.create()}>첫 PAS 생성</button><button onClick={()=>p.onOpenChange(false)}>설정 닫기</button></div>:null}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT=true;
afterEach(()=>{vi.clearAllMocks();document.body.innerHTML='';});
it('adds only the first chrome action and preserves brand, search, config and theme',async()=>{mocks.list.mockResolvedValue({sessions:[{session_id:'a',node_id:'n',agent_id:'a'}]});const host=document.createElement('div');document.body.append(host);const root=createRoot(host);await act(async()=>root.render(<V3GlobalToolbar onOpenConfig={vi.fn()} onOpenSearch={vi.fn()}/>));expect(host.querySelector('.dashboard-toolbar-brand')?.textContent).toBe('Soulstream');expect(host.querySelector('.dashboard-toolbar-search')?.textContent).toContain('Search sessions');expect(host.querySelector('.dashboard-toolbar-actions')?.firstElementChild?.getAttribute('data-testid')).toBe('persistent-session-entry');expect(host.querySelector('[data-testid="persistent-session-entry"] img')?.className).toContain('rounded-full');await act(async()=>host.querySelector<HTMLButtonElement>('[data-testid="persistent-session-entry"]')!.click());expect(mocks.navigate).toHaveBeenCalledWith('/persistent/a');act(()=>root.unmount());});
it('opens existing create settings for zero PAS',async()=>{mocks.list.mockResolvedValue({sessions:[],create_defaults:{node_id:'node',preferred_agent_id:'default'}});const host=document.createElement('div');document.body.append(host);const root=createRoot(host);await act(async()=>root.render(<PersistentSessionEntry/>));expect(host.querySelector('img')?.getAttribute('src')).toBe('/api/nodes/node/agents/default/portrait');await act(async()=>host.querySelector<HTMLButtonElement>('button')!.click());expect(host.querySelector('[data-testid="entry-config"]')).not.toBeNull();act(()=>root.unmount());});

it('refreshes after creating the first PAS in settings without remounting the entry',async()=>{
 const empty={sessions:[],create_defaults:{node_id:'node',preferred_agent_id:'default'}};
 mocks.list.mockResolvedValue(empty);mocks.create.mockImplementation(()=>mocks.list.mockResolvedValue({sessions:[{session_id:'created',node_id:'node',agent_id:'default'}]}));
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);await act(async()=>root.render(<PersistentSessionEntry/>));const entry=host.querySelector<HTMLButtonElement>('[data-testid="persistent-session-entry"]')!;
 await act(async()=>entry.click());expect(host.querySelector('[data-testid="entry-config"]')).not.toBeNull();await act(async()=>[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='첫 PAS 생성')!.click());await act(async()=>[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='설정 닫기')!.click());expect(host.querySelector('[data-testid="entry-config"]')).toBeNull();
 await act(async()=>entry.click());expect(mocks.navigate).toHaveBeenCalledWith('/persistent/created');expect(mocks.create).toHaveBeenCalledOnce();expect(mocks.list).toHaveBeenCalledTimes(3);act(()=>root.unmount());
});
it('uses the fresh multiple and zero responses instead of cached entry counts',async()=>{
 const first={session_id:'first',node_id:'node',agent_id:'default',display_name:'첫 PAS'},second={...first,session_id:'second',display_name:'둘째 PAS'};
 mocks.list.mockResolvedValue({sessions:[first]});const host=document.createElement('div');document.body.append(host);const root=createRoot(host);await act(async()=>root.render(<PersistentSessionEntry/>));
 mocks.list.mockResolvedValue({sessions:[second,first]});await act(async()=>host.querySelector<HTMLButtonElement>('[data-testid="persistent-session-entry"]')!.click());expect(mocks.navigate).not.toHaveBeenCalled();const choice=[...document.body.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='둘째 PAS');expect(choice).toBeDefined();await act(async()=>choice!.click());expect(mocks.navigate).toHaveBeenCalledWith('/persistent/second');
 mocks.list.mockResolvedValue({sessions:[],create_defaults:{node_id:'node',preferred_agent_id:'default'}});await act(async()=>host.querySelector<HTMLButtonElement>('[data-testid="persistent-session-entry"]')!.click());expect(host.querySelector('[data-testid="entry-config"]')).not.toBeNull();expect([...document.body.querySelectorAll('button')].some(b=>b.textContent==='둘째 PAS')).toBe(false);expect(mocks.list).toHaveBeenCalledTimes(3);act(()=>root.unmount());
});
it('coalesces clicks during lookup and sends lookup failures to the existing entry error surface',async()=>{
 mocks.list.mockResolvedValue({sessions:[{session_id:'cached',node_id:'node',agent_id:'default'}]});const host=document.createElement('div');document.body.append(host);const root=createRoot(host);await act(async()=>root.render(<PersistentSessionEntry/>));let reject!:(error:Error)=>void;mocks.list.mockReturnValue(new Promise((_,r)=>{reject=r}));
 const entry=host.querySelector<HTMLButtonElement>('[data-testid="persistent-session-entry"]')!;await act(async()=>{entry.click();entry.click()});expect(mocks.list).toHaveBeenCalledTimes(2);expect(mocks.navigate).not.toHaveBeenCalled();await act(async()=>reject(new Error('offline')));expect(mocks.navigate).toHaveBeenCalledWith('/persistent');act(()=>root.unmount());
});
