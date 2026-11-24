/** @vitest-environment jsdom */
import { act } from 'react';import { createRoot } from 'react-dom/client';import { expect,it,vi } from 'vitest';
import { usePersistentSessionStartup } from './use-persistent-session-startup';
import { setPersistentSessionOpenOnStart,setPersistentSessionLastSessionId } from '../lib/persistent-session-device-preferences';
const mocks=vi.hoisted(()=>({list:vi.fn(),navigate:vi.fn()}));
vi.mock('@seosoyoung/soul-ui',async importOriginal=>{const actual=await importOriginal<typeof import('@seosoyoung/soul-ui')>();return {...actual,useAuth:()=>({user:{email:'startup@example.com'},isLoading:false,isAuthenticated:true}),useToast:()=>({showToast:vi.fn()})};});
vi.mock('../lib/persistent-sessions',()=>({createPersistentSessionsApi:()=>({list:mocks.list})}));
vi.mock('../dashboard-navigation',()=>({navigateDashboard:(...args:any[])=>mocks.navigate(...args)}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT=true;
it('evaluates once, prefers the last valid PAS, and home does not bounce',async()=>{localStorage.clear();setPersistentSessionOpenOnStart('startup@example.com',true);setPersistentSessionLastSessionId('startup@example.com','b');mocks.list.mockResolvedValue({sessions:[{session_id:'a'},{session_id:'b'}]});
 const host=document.createElement('div');const root=createRoot(host);function Harness({path}:{path:string}){usePersistentSessionStartup(path);return null}
 await act(async()=>root.render(<Harness path="/"/>));expect(mocks.navigate).toHaveBeenCalledWith('/persistent/b',true);
 await act(async()=>root.render(<Harness path="/persistent/b"/>));await act(async()=>root.render(<Harness path="/"/>));expect(mocks.list).toHaveBeenCalledTimes(1);act(()=>root.unmount());});
it.each(['/components','/persistent/a','/?session=external','/?card=card-1','/?document=doc-1','/?folder=folder-1','/?page=page-1'])('honors explicit entry %s',async path=>{mocks.list.mockClear();mocks.navigate.mockClear();window.history.replaceState(null,'',path);const root=createRoot(document.createElement('div'));function H(){usePersistentSessionStartup(window.location.pathname);return null}await act(async()=>root.render(<H/>));expect(mocks.list).not.toHaveBeenCalled();act(()=>root.unmount());window.history.replaceState(null,'','/');});
it.each([
 [[],null,'/persistent'],
 [[{session_id:'a'}],null,'/persistent/a'],
 [[{session_id:'a'},{session_id:'b'}],'deleted','/persistent'],
])('handles startup PAS inventory %j',async(sessions,last,target)=>{localStorage.clear();mocks.list.mockClear();mocks.navigate.mockClear();setPersistentSessionOpenOnStart('startup@example.com',true);setPersistentSessionLastSessionId('startup@example.com',last);mocks.list.mockResolvedValue({sessions});const root=createRoot(document.createElement('div'));function H(){usePersistentSessionStartup('/');return null}await act(async()=>root.render(<H/>));if(target)expect(mocks.navigate).toHaveBeenCalledWith(target,true);else expect(mocks.navigate).not.toHaveBeenCalled();act(()=>root.unmount());});

it('opens the PAS window by default but not when the user saved false',async()=>{
 for(const [saved,expected] of [[undefined,1],[false,0]] as const){
  localStorage.clear();mocks.list.mockClear();mocks.navigate.mockClear();
  if(saved!==undefined)setPersistentSessionOpenOnStart('startup@example.com',saved);
  mocks.list.mockResolvedValue({sessions:[{session_id:'only'}]});
  const root=createRoot(document.createElement('div'));function H(){usePersistentSessionStartup('/');return null}
  await act(async()=>root.render(<H/>));
  expect(mocks.navigate).toHaveBeenCalledTimes(expected);
  if(expected)expect(mocks.navigate).toHaveBeenCalledWith('/persistent/only',true);
  act(()=>root.unmount());
 }
});
it('sends an empty inventory to /persistent once per page load and does not resend after returning home',async()=>{
 localStorage.clear();mocks.list.mockClear();mocks.navigate.mockClear();
 mocks.list.mockResolvedValue({sessions:[]});
 const root=createRoot(document.createElement('div'));function H({path}:{path:string}){usePersistentSessionStartup(path);return null}
 await act(async()=>root.render(<H path="/"/>));
 expect(mocks.navigate).toHaveBeenCalledTimes(1);expect(mocks.navigate).toHaveBeenCalledWith('/persistent',true);
 await act(async()=>root.render(<H path="/persistent"/>));await act(async()=>root.render(<H path="/"/>));
 expect(mocks.navigate).toHaveBeenCalledTimes(1);expect(mocks.list).toHaveBeenCalledTimes(1);
 act(()=>root.unmount());
});
