/** @vitest-environment jsdom */
import { act } from 'react';import { createRoot } from 'react-dom/client';import { afterEach,expect,it,vi } from 'vitest';
import { PersistentSessionEntry, PersistentSessionSwitch } from './PersistentSessionEntry';
import { V3GlobalToolbar } from './V3GlobalToolbar';
const mocks=vi.hoisted(()=>({list:vi.fn(),navigate:vi.fn(),mobile:false,anchors:[] as unknown[]}));
vi.mock('@seosoyoung/soul-ui',async()=>{const React=await import('react');const actual=await vi.importActual<any>('@seosoyoung/soul-ui');return {...actual,useAuth:()=>({user:{email:'entry@example.com'}}),useIsMobile:()=>mocks.mobile,PopoverPopup:(props:any)=>{mocks.anchors.push(props.anchor);return React.createElement(actual.PopoverPopup,props)}}});
vi.mock('../lib/persistent-sessions',()=>({createPersistentSessionsApi:()=>({list:mocks.list})}));
vi.mock('../dashboard-navigation',()=>({navigateDashboard:(...a:any[])=>mocks.navigate(...a)}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT=true;
afterEach(()=>{vi.clearAllMocks();mocks.mobile=false;mocks.anchors=[];document.body.innerHTML='';});
it.each([true,false])('uses the toolbar as the popover anchor only on mobile: %s',async(mobile)=>{
 mocks.mobile=mobile;
 const sessions=[{session_id:'first',node_id:'node',agent_id:'default',display_name:'첫 PAS'},{session_id:'second',node_id:'node',agent_id:'default',display_name:'둘째 PAS'}];
 mocks.list.mockResolvedValue({sessions});
 const host=document.createElement('div');host.className='dashboard-toolbar-actions';document.body.append(host);const root=createRoot(host);
 try {
  await act(async()=>root.render(<PersistentSessionEntry/>));
  await act(async()=>host.querySelector<HTMLButtonElement>('[data-testid="persistent-session-entry"]')!.click());
  const home=mocks.anchors.at(-1);
  await act(async()=>root.render(<PersistentSessionSwitch sessions={sessions as any} currentSessionId="first"/>));
  await act(async()=>host.querySelector<HTMLButtonElement>('[data-testid="persistent-session-switch"]')!.click());
  const switcher=mocks.anchors.at(-1);
  expect([home,switcher]).toEqual(mobile?[host,host]:[undefined,undefined]);
 } finally {await act(async()=>root.unmount());}
});
it('adds only the first chrome action and preserves brand, search, config and theme',async()=>{mocks.list.mockResolvedValue({sessions:[{session_id:'a',node_id:'n',agent_id:'a'}]});const host=document.createElement('div');document.body.append(host);const root=createRoot(host);await act(async()=>root.render(<V3GlobalToolbar onOpenConfig={vi.fn()} onOpenSearch={vi.fn()}/>));expect(host.querySelector('.dashboard-toolbar-brand')?.textContent).toBe('Soulstream');expect(host.querySelector('.dashboard-toolbar-search')?.textContent).toContain('세션 검색');expect(host.querySelector('.dashboard-toolbar-actions')?.firstElementChild?.getAttribute('data-testid')).toBe('persistent-session-entry');expect(host.querySelector('[data-testid="persistent-session-entry"] img')?.className).toContain('rounded-full');await act(async()=>host.querySelector<HTMLButtonElement>('[data-testid="persistent-session-entry"]')!.click());expect(mocks.navigate).toHaveBeenCalledWith('/persistent/a');act(()=>root.unmount());});
it('sends zero PAS to the PAS window, which draws the empty state',async()=>{mocks.list.mockResolvedValue({sessions:[],create_defaults:{node_id:'node',preferred_agent_id:'default'}});const host=document.createElement('div');document.body.append(host);const root=createRoot(host);await act(async()=>root.render(<PersistentSessionEntry/>));expect(host.querySelector('img')?.getAttribute('src')).toBe('/api/agent-portraits/default');await act(async()=>host.querySelector<HTMLButtonElement>('button')!.click());expect(mocks.navigate).toHaveBeenCalledWith('/persistent');expect(document.body.querySelector('[data-testid="config-category-nav"]')).toBeNull();expect(document.body.querySelector('[role="dialog"]')).toBeNull();act(()=>root.unmount());});

it('uses the fresh multiple and zero responses instead of cached entry counts',async()=>{
 const first={session_id:'first',node_id:'node',agent_id:'default',display_name:'첫 PAS'},second={...first,session_id:'second',display_name:'둘째 PAS'};
 mocks.list.mockResolvedValue({sessions:[first]});const host=document.createElement('div');document.body.append(host);const root=createRoot(host);await act(async()=>root.render(<PersistentSessionEntry/>));
 mocks.list.mockResolvedValue({sessions:[second,first]});await act(async()=>host.querySelector<HTMLButtonElement>('[data-testid="persistent-session-entry"]')!.click());expect(mocks.navigate).not.toHaveBeenCalled();expect(document.body.querySelector('[data-slot="popover-popup"]')?.classList.contains('v3-popup-chrome')).toBe(true);const choice=[...document.body.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='둘째 PAS');expect(choice).toBeDefined();await act(async()=>choice!.click());expect(mocks.navigate).toHaveBeenCalledWith('/persistent/second');
 mocks.list.mockResolvedValue({sessions:[],create_defaults:{node_id:'node',preferred_agent_id:'default'}});await act(async()=>host.querySelector<HTMLButtonElement>('[data-testid="persistent-session-entry"]')!.click());expect(mocks.navigate).toHaveBeenLastCalledWith('/persistent');expect([...document.body.querySelectorAll('button')].some(b=>b.textContent==='둘째 PAS')).toBe(false);expect(mocks.list).toHaveBeenCalledTimes(3);act(()=>root.unmount());
});
it('coalesces clicks during lookup and sends lookup failures to the existing entry error surface',async()=>{
 mocks.list.mockResolvedValue({sessions:[{session_id:'cached',node_id:'node',agent_id:'default'}]});const host=document.createElement('div');document.body.append(host);const root=createRoot(host);await act(async()=>root.render(<PersistentSessionEntry/>));let reject!:(error:Error)=>void;mocks.list.mockReturnValue(new Promise((_,r)=>{reject=r}));
 const entry=host.querySelector<HTMLButtonElement>('[data-testid="persistent-session-entry"]')!;await act(async()=>{entry.click();entry.click()});expect(mocks.list).toHaveBeenCalledTimes(2);expect(mocks.navigate).not.toHaveBeenCalled();await act(async()=>reject(new Error('offline')));expect(mocks.navigate).toHaveBeenCalledWith('/persistent');act(()=>root.unmount());
});
