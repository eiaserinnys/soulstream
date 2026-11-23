/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { useDashboardStore } from '@seosoyoung/soul-ui/stores/dashboard-store';
import { CardWorkspace } from './CardWorkspace';
import { createChatSessionStore } from '@seosoyoung/soul-ui';
import { useSessionFilesTurn } from './use-session-files-turn';
import { reviewDetail, reviewFolders, reviewSession } from './components-review-fixtures';
vi.mock('./useCardSessionPages',async original=>({...await original<any>(),useCardSessionPages:()=>({sessions:[reviewSession],loading:false})}));
vi.mock('@seosoyoung/soul-ui/cards/CardSessionVirtualList',()=>({CardSessionVirtualList:({data,itemContent}:any)=><div>{data.map((row:any,i:number)=><div key={i}>{itemContent(i,row)}</div>)}</div>}));
vi.mock('@seosoyoung/soul-ui',async original=>({...await original<any>(),useAuth:()=>({user:null})}));
vi.mock('./PersistentSessionChatView',()=>({PersistentSessionChatView:()=> <div>대화</div>}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLDivElement,root:Root;
const detail={...reviewDetail,card:{...reviewDetail.card,assigneeKind:'session' as const,assigneeSessionId:reviewSession.agentSessionId},sessions:[{sessionId:reviewSession.agentSessionId}]};
beforeEach(()=>{useDashboardStore.getState().setActiveSession('pas');host=document.createElement('div');host.className='v3-shell';document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.restoreAllMocks();});
async function mount(mobileMode=false,onCloseChat?:()=>void){const state=useDashboardStore.getState();const select=vi.fn((session:any)=>{state.setActiveSessionSummary(session);state.setActiveSession(session.agentSessionId);});await act(()=>root.render(<CardWorkspace cardId={detail.card.id} sampleDetail={detail as any} folders={reviewFolders} onClose={()=>{}} onOpenSession={select} mobileMode={mobileMode} onCloseChat={onCloseChat} mobileTab="chat" activeSession={undefined} chatInputDisabled historyEnabled={false} sessionStreamActive={false} sessionConnectionStatus="disconnected" reconnectSession={()=>{}} onAcknowledgedReview={()=>{}}/>));return select;}
it('renders the main two-column overlay, linked-session detail, and default empty chat state',async()=>{const select=await mount();expect(host.querySelector('[data-placement="overlay"]')).not.toBeNull();expect(host.querySelector('.v3-card-workspace-pair > [data-testid="v3-card-workspace-left-divider"]')).not.toBeNull();expect(host.querySelector('[data-testid="card-detail"]')).not.toBeNull();expect(host.querySelector('[data-testid="v3-card-session-chat"]')?.textContent).toContain('위임 관계에서 세션을 선택하세요.');expect([...host.querySelectorAll('[role="tab"]')].map(e=>e.textContent?.replace(/\d/g,'').trim())).toEqual(['확인 항목','커멘트','세션','노트']);expect(host.querySelector('[data-card-section="sessions"]')).not.toBeNull();expect(select).toHaveBeenCalled();});

it("returns from phone chat through the title-row close button without closing the card",async()=>{const back=vi.fn();await mount(true,back);const workspace=host.querySelector('[data-testid="v3-card-workspace"]');const button=host.querySelector<HTMLButtonElement>('[aria-label="채팅 닫기"]');expect(button).not.toBeNull();expect(button!.parentElement).toBe(host.querySelector('.v3-chat-session-title')!.parentElement);expect(button!.parentElement!.querySelector('.v3-chat-status')).toBeNull();await act(()=>button!.click());expect(back).toHaveBeenCalledOnce();expect(host.querySelector('[data-testid="v3-card-workspace"]')).toBe(workspace);});
it("keeps the wide chat header unchanged",async()=>{await mount(false,vi.fn());expect(host.querySelector('[aria-label="채팅 닫기"]')).toBeNull();});

it('replaces the card detail with files and restores it when closed', async () => {
 const {reviewSessionFiles}=await import('./components-review-fixtures');
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(reviewSessionFiles),{status:200,headers:{'Content-Type':'application/json'}})));
 await act(async()=>root.render(<CardWorkspace cardId={detail.card.id} sampleDetail={detail as any} folders={reviewFolders} onClose={()=>{}} onOpenSession={()=>{}} mobileMode={false} mobileTab="chat" activeSession={reviewSession} chatInputDisabled historyEnabled={false} sessionStreamActive={false} sessionConnectionStatus="disconnected" reconnectSession={()=>{}} onAcknowledgedReview={()=>{}}/>));
 const trigger=[...host.querySelectorAll('button')].find(node=>node.textContent?.trim()==='파일'); expect(trigger).toBeDefined();
 await act(async()=>{trigger!.click();});
 expect(host.querySelector('.v3-session-files-pane')?.textContent).toContain('outbox_retry.ts');
 const scroll=host.querySelector<HTMLElement>('.v3-session-files-body')!;scroll.scrollTop=123;await act(async()=>scroll.dispatchEvent(new Event('scroll',{bubbles:true})));
 expect(host.querySelector('.v3-files-detail-hidden [data-testid="card-detail"]')).not.toBeNull();
 await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="파일 닫기"]')!.click());
 expect(host.querySelector('.v3-session-files-pane')).toBeNull(); expect(host.querySelector('.v3-files-detail-visible [data-testid="card-detail"]')).not.toBeNull();
 await act(async()=>trigger!.click());expect(host.querySelector<HTMLElement>('.v3-session-files-body')!.scrollTop).toBe(123);
 await act(async()=>[...host.querySelectorAll<HTMLButtonElement>('.v3-session-files-pane button')].find(b=>b.textContent?.includes('읽기만 한 파일'))!.click());
 const expandedScroll=host.querySelector<HTMLElement>('.v3-session-files-body')!;expandedScroll.scrollTop=234;await act(async()=>expandedScroll.dispatchEvent(new Event('scroll',{bubbles:true})));
 await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="파일 닫기"]')!.click());
 await act(async()=>trigger!.click());
 expect([...host.querySelectorAll('.v3-session-files-pane [aria-expanded="true"]')].some(b=>b.textContent?.includes('읽기만 한 파일'))).toBe(true);expect(host.querySelector<HTMLElement>('.v3-session-files-body')!.scrollTop).toBe(234);
 const section=(name:string)=>[...host.querySelectorAll<HTMLButtonElement>('.v3-session-files-pane button')].find(b=>b.textContent?.includes(name))!;
 await act(async()=>{section('이번 세션').click();section('다른 변경').click();});
 await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="파일 닫기"]')!.click());
 await act(async()=>trigger!.click());
 expect(section('이번 세션').getAttribute('aria-expanded')).toBe('false');
 expect(section('다른 변경').getAttribute('aria-expanded')).toBe('true');
 vi.unstubAllGlobals();
});

it('observes complete events from the matching chat session', async () => {
 const scope=createChatSessionStore('session-one');
 function Harness(){return <span>{useSessionFilesTurn('session-one',scope)}</span>;}
 await act(async()=>root.render(<Harness/>));
 expect(host.textContent).toBe('0');
 await act(async()=>scope.store.getState().processEvent({type:'complete',result:'끝',attachments:[]} as any,1));
 expect(host.textContent).toBe('1');
 await act(async()=>scope.store.getState().processEvent({type:'user_message',user:'u',text:'다음'} as any,2));
 expect(host.textContent).toBe('1');
});

it('keeps the chat and open file pane mounted across mobile and desktop', async () => {
 const {reviewSessionFiles}=await import('./components-review-fixtures');
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(reviewSessionFiles),{status:200,headers:{'Content-Type':'application/json'}})));
 const render=(mobileMode:boolean)=><CardWorkspace cardId={detail.card.id} sampleDetail={detail as any} folders={reviewFolders} onClose={()=>{}} onOpenSession={()=>{}} mobileMode={mobileMode} mobileTab="chat" activeSession={reviewSession} chatInputDisabled historyEnabled={false} sessionStreamActive={false} sessionConnectionStatus="disconnected" reconnectSession={()=>{}} onAcknowledgedReview={()=>{}}/>;
 await act(async()=>root.render(render(false)));
 await act(async()=>[...host.querySelectorAll('button')].find(node=>node.textContent?.trim()==='파일')!.click());
 const pane=host.querySelector('.v3-session-files-pane'); const chat=host.querySelector('[data-testid="v3-card-session-chat"]');
 expect(pane).not.toBeNull();
 await act(async()=>root.render(render(true)));
 expect(host.querySelector('.v3-session-files-pane')).toBe(pane); expect(host.querySelector('[data-testid="v3-card-session-chat"]')).toBe(chat);
 await act(async()=>root.render(render(false)));
 expect(host.querySelector('.v3-session-files-pane')).toBe(pane); expect(host.querySelector('[data-testid="v3-card-session-chat"]')).toBe(chat);
 vi.unstubAllGlobals();
});
