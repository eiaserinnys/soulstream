/** @vitest-environment jsdom */
import { createElement, type HTMLAttributes } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceSessionColumn } from "./WorkspaceSessionColumn";

vi.mock("@seosoyoung/soul-ui",()=>({
 ChatView:()=>createElement("div",{"data-testid":"chat-content"},"선택한 세션 대화"),
 DashboardIconCap:({label,...props}:HTMLAttributes<HTMLButtonElement>&{label:string})=>createElement("button",{...props,"aria-label":label}),
 DragHandle:()=>null,SessionModelPresetBadge:()=>null,SessionStoryDisclosure:()=>null,
 STATUS_CONFIG:{completed:{label:"완료"},unknown:{label:"알 수 없음"}},useGlassSurface:()=>false,
}));
vi.mock("./V3SessionReviewBanner",()=>({V3SessionReviewBanner:()=>null}));
vi.mock("./SessionStreamStatus",()=>({SessionStreamStatus:()=>null}));
afterEach(()=>document.body.replaceChildren());

it("shows the selected session in the existing resizable column without an overlay",()=>{
 const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
 const resize=vi.fn(),close=vi.fn();
 Object.defineProperty(document.documentElement,"clientWidth",{configurable:true,value:1440});
 flushSync(()=>root.render(createElement(WorkspaceSessionColumn,{
  activeSession:{agentSessionId:"s",displayName:"카드 작업",status:"completed",createdAt:"2026-09-30T12:00:00Z"} as any,
  chatClassName:"v3-card-session-chat",chatTestId:"card-session-chat",resizeClassName:"v3-session-panel-resize",resizeTestId:"resize",onResize:resize,onClose:close,
  chatInputDisabled:false,historyEnabled:true,sessionStreamActive:true,sessionConnectionStatus:"connected" as any,reconnectSession:()=>undefined,onAcknowledgedReview:()=>undefined,
 })));
 expect(container.textContent).toContain("카드 작업");
 expect(container.querySelector('[data-testid="chat-content"]')).not.toBeNull();
 expect(container.querySelector('.v3-workspace-scrim')).toBeNull();
 const separator=container.querySelector('[role="separator"]')!;
 flushSync(()=>separator.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true,cancelable:true})));
 expect(resize).toHaveBeenCalledOnce();expect(resize.mock.calls[0][0]).toBeCloseTo(-24*100/1440);
 flushSync(()=>container.querySelector<HTMLButtonElement>('button[aria-label="채팅 닫기"]')!.click());expect(close).toHaveBeenCalledOnce();
 flushSync(()=>root.unmount());
});
