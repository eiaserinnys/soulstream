/** @vitest-environment jsdom */
import { act } from 'react';import { createRoot } from 'react-dom/client';import { afterEach,expect,it,vi } from 'vitest';
import { PersistentSessionEntry } from './PersistentSessionEntry';
import { V3GlobalToolbar } from './V3GlobalToolbar';
const mocks=vi.hoisted(()=>({list:vi.fn(),navigate:vi.fn()}));
vi.mock('@seosoyoung/soul-ui',async()=>({...await vi.importActual<any>('@seosoyoung/soul-ui'),useAuth:()=>({user:{email:'entry@example.com'}})}));
vi.mock('../lib/persistent-sessions',()=>({createPersistentSessionsApi:()=>({list:mocks.list})}));
vi.mock('../dashboard-navigation',()=>({navigateDashboard:(...a:any[])=>mocks.navigate(...a)}));
vi.mock('../components/ConfigModal',()=>({ConfigModal:(p:any)=>p.open?<div data-testid="entry-config"/>:null}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT=true;
afterEach(()=>{vi.clearAllMocks();document.body.innerHTML='';});
it('adds only the first chrome action and preserves brand, search, config and theme',async()=>{mocks.list.mockResolvedValue({sessions:[{session_id:'a',node_id:'n',agent_id:'a'}]});const host=document.createElement('div');document.body.append(host);const root=createRoot(host);await act(async()=>root.render(<V3GlobalToolbar onOpenConfig={vi.fn()} onOpenSearch={vi.fn()}/>));expect(host.querySelector('.dashboard-toolbar-brand')?.textContent).toBe('Soulstream');expect(host.querySelector('.dashboard-toolbar-search')?.textContent).toContain('Search sessions');expect(host.querySelector('.dashboard-toolbar-actions')?.firstElementChild?.getAttribute('data-testid')).toBe('persistent-session-entry');expect(host.querySelector('[data-testid="persistent-session-entry"] img')?.className).toContain('rounded-full');await act(async()=>host.querySelector<HTMLButtonElement>('[data-testid="persistent-session-entry"]')!.click());expect(mocks.navigate).toHaveBeenCalledWith('/persistent/a');act(()=>root.unmount());});
it('opens existing create settings for zero PAS',async()=>{mocks.list.mockResolvedValue({sessions:[],create_defaults:{node_id:'node',preferred_agent_id:'default'}});const host=document.createElement('div');document.body.append(host);const root=createRoot(host);await act(async()=>root.render(<PersistentSessionEntry/>));expect(host.querySelector('img')?.getAttribute('src')).toBe('/api/nodes/node/agents/default/portrait');await act(async()=>host.querySelector<HTMLButtonElement>('button')!.click());expect(host.querySelector('[data-testid="entry-config"]')).not.toBeNull();act(()=>root.unmount());});
