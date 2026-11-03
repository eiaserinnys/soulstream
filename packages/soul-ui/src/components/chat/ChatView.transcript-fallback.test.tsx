/** @vitest-environment jsdom */
import { act, forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ChatView } from './ChatView';
import { useDashboardStore } from '../../stores/dashboard-store';

// Same jsdom Virtuoso boundary as ChatView.feedback-lifetime: keep the real ChatInput and history hook.
vi.mock('react-virtuoso',()=>({Virtuoso:forwardRef((props:any,ref)=>{
 const scroller=useRef<HTMLDivElement>(null);
 useImperativeHandle(ref,()=>({scrollToIndex:vi.fn(),scrollBy:vi.fn(),scrollTo:vi.fn()}));
 useEffect(()=>{props.scrollerRef?.(scroller.current);return()=>props.scrollerRef?.(null)},[props.scrollerRef]);
 return <div ref={scroller}>{props.data.map((item:any,i:number)=><div key={i}>{props.itemContent(props.firstItemIndex+i,item)}</div>)}</div>;
})}));
vi.mock('./hooks',()=>({useLlmContext:()=>undefined}));
vi.mock('../../providers/AuthProvider',()=>({useAuth:()=>({isAuthenticated:false,user:null})}));
vi.mock('../LiquidGlassProvider',()=>({useGlassSurface:()=>false}));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;

it('keeps the real composer while fallback suppresses history, then restores transcript',async()=>{
 vi.stubGlobal('ResizeObserver',class{observe(){} unobserve(){} disconnect(){}});
 const fetchMock=vi.fn(async(_input:RequestInfo | URL)=>new Response(JSON.stringify({messages:[],next_cursor:null}),{headers:{'Content-Type':'application/json'}}));
 vi.stubGlobal('fetch',fetchMock);useDashboardStore.getState().reset();useDashboardStore.getState().setActiveSession('target');
 useDashboardStore.getState().setActiveSessionSummary(null);
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 try{
  await act(async()=>root.render(<ChatView presentation="manuscript" transcriptFallback={<div>대화 준비 중</div>}/>));
  expect(host.querySelector('[data-slot="chat-root"]')?.textContent).toContain('대화 준비 중');
  expect(host.querySelector('[data-testid="chat-input"] textarea')).not.toBeNull();
  expect(fetchMock.mock.calls.some(([url])=>String(url).includes('/timeline'))).toBe(false);
  await act(async()=>root.render(<ChatView presentation="manuscript"/>));
  expect(host.textContent).not.toContain('대화 준비 중');
  expect(fetchMock.mock.calls.some(([url])=>String(url).includes('/timeline'))).toBe(true);
 }finally{act(()=>root.unmount());host.remove();useDashboardStore.getState().reset();vi.unstubAllGlobals();}
});
