/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { useDashboardStore } from '@seosoyoung/soul-ui/stores/dashboard-store';
import { CardWorkspace } from './CardWorkspace';
import { reviewDetail, reviewFolders, reviewSession } from './components-review-fixtures';
vi.mock('./useCardSessionPages',async original=>({...await original<any>(),useCardSessionPages:()=>({sessions:[reviewSession],loading:false})}));
vi.mock('@seosoyoung/soul-ui/cards/CardSessionVirtualList',()=>({CardSessionVirtualList:({data,itemContent}:any)=><div>{data.map((row:any,i:number)=><div key={i}>{itemContent(i,row)}</div>)}</div>}));
vi.mock('@seosoyoung/soul-ui',async original=>({...await original<any>(),useAuth:()=>({user:null})}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLDivElement,root:Root;
const detail={...reviewDetail,card:{...reviewDetail.card,assigneeKind:'session' as const,assigneeSessionId:reviewSession.agentSessionId},sessions:[{sessionId:reviewSession.agentSessionId}]};
beforeEach(()=>{useDashboardStore.getState().setActiveSession('pas');host=document.createElement('div');host.className='v3-shell';document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.restoreAllMocks();});
async function mount(mobileMode=false,onCloseChat?:()=>void){const state=useDashboardStore.getState();const select=vi.fn((session:any)=>{state.setActiveSessionSummary(session);state.setActiveSession(session.agentSessionId);});await act(()=>root.render(<CardWorkspace cardId={detail.card.id} sampleDetail={detail as any} folders={reviewFolders} onClose={()=>{}} onOpenSession={select} mobileMode={mobileMode} onCloseChat={onCloseChat} mobileTab="chat" activeSession={undefined} chatInputDisabled historyEnabled={false} sessionStreamActive={false} sessionConnectionStatus="disconnected" reconnectSession={()=>{}} onAcknowledgedReview={()=>{}}/>));return select;}
it('renders the main two-column overlay, linked-session detail, and default empty chat state',async()=>{const select=await mount();expect(host.querySelector('[data-placement="overlay"]')).not.toBeNull();expect(host.querySelector('.v3-card-workspace-pair > [data-testid="v3-card-workspace-left-divider"]')).not.toBeNull();expect(host.querySelector('[data-testid="card-detail"]')).not.toBeNull();expect(host.querySelector('[data-testid="v3-card-session-chat"]')?.textContent).toContain('위임 관계에서 세션을 선택하세요.');expect([...host.querySelectorAll('[role="tab"]')].map(e=>e.textContent?.replace(/\d/g,'').trim())).toEqual(['확인 항목','커멘트','세션','노트']);expect(host.querySelector('[data-card-section="sessions"]')).not.toBeNull();expect(select).toHaveBeenCalled();});

it("returns from phone chat through the existing header without closing the card",async()=>{const back=vi.fn();await mount(true,back);const workspace=host.querySelector('[data-testid="v3-card-workspace"]');const button=host.querySelector<HTMLButtonElement>('[aria-label="채팅 닫기"]');expect(button).not.toBeNull();await act(()=>button!.click());expect(back).toHaveBeenCalledOnce();expect(host.querySelector('[data-testid="v3-card-workspace"]')).toBe(workspace);});
it("keeps the wide chat header unchanged",async()=>{await mount(false,vi.fn());expect(host.querySelector('[aria-label="채팅 닫기"]')).toBeNull();});
