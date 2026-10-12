/** @vitest-environment jsdom */
import { act, forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatView } from "./ChatView";
import { createChatSessionStore, useDashboardStore } from "../../stores/dashboard-store";
import { useChatUiController } from "../chat-ui/ChatUiControllerProvider";
import { documentFixture } from "../chat-ui/chat-ui.test-fixture";
import { submitIntervention } from "./submitIntervention";
import type { PendingChatSend } from "../../stores/dashboard-store-types";

// Reuse the existing ChatView jsdom Virtuoso pattern. Layout/virtualization is
// replaced; real ChatView scope/provider, ChatInput, pending row and send hook run.
vi.mock("react-virtuoso", () => ({ Virtuoso: forwardRef((props: any, ref) => {
  const scroller = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => ({ scrollToIndex: vi.fn(), scrollBy: vi.fn(), scrollTo: vi.fn() }));
  useEffect(() => { props.scrollerRef?.(scroller.current); return () => props.scrollerRef?.(null); }, [props.scrollerRef]);
  return <div ref={scroller}><FeedbackTrigger />{props.data.map((item: any, i: number) =>
    <div key={props.computeItemKey(props.firstItemIndex + i, item)}>{props.itemContent(props.firstItemIndex + i, item)}</div>)}</div>;
}) }));
vi.mock("./useMessageHistoryBuffer", () => ({ VIEWPORT_FILL_MARGIN_PX: 200, useMessageHistoryBuffer: () => ({
  loading: false, reachedTop: true, canLoadOlder: false, blockedReason: null, requestOlder: vi.fn(), notifyViewportGeometry: vi.fn(),
}) }));
vi.mock("./hooks", () => ({ useLlmContext: () => undefined }));
vi.mock("../../providers/AuthProvider", () => ({ useAuth: () => ({ isAuthenticated: false, user: null }) }));
vi.mock("./submitIntervention", async original => ({
  ...(await original<typeof import("./submitIntervention")>()), submitIntervention: vi.fn(),
}));
vi.mock("../../hooks/useFileUpload", () => ({ useFileUpload: () => ({
  files: [], isUploading: false, isReady: true, addFiles: vi.fn(), removeFile: vi.fn(), resetLocal: vi.fn(),
  restoreUploadedFiles: vi.fn(), uploadedPaths: [],
}) }));
vi.mock("../LiquidGlassProvider", () => ({ useGlassSurface: () => false }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function FeedbackTrigger() {
  const controller = useChatUiController("fixture", "fixture", documentFixture);
  return <button onClick={() => controller.act({ type: "reset" }, "reset")}>안내 열기</button>;
}
let host: HTMLDivElement, root: Root;
let overlay: ReturnType<typeof createChatSessionStore>;
const pane = (name: string) => host.querySelector<HTMLElement>(`[data-pane="${name}"]`)!;
const notice = (name: string) => pane(name).querySelector('[data-testid="chat-input"] [role="status"]');
const button = (name: string, text: string) => Array.from(pane(name).querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent === text)!;
async function click(name: string, text: string) { await act(async () => button(name, text).click()); }
async function type(name: string, value: string) {
  const editor = pane(name).querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, value);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function mount() {
  await act(async () => root.render(<>
    <section data-pane="main"><ChatView historyEnabled={false} showRuntimeStrips={false} /></section>
    <section data-pane="overlay"><ChatView storeScope={overlay} presentation="manuscript" historyEnabled={false} showRuntimeStrips={false} /></section>
  </>));
}
beforeEach(async () => {
  // jsdom has no layout observer; this test checks scope and send timing.
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  useDashboardStore.getState().reset();
  useDashboardStore.getState().setActiveSession("main-session");
  overlay = createChatSessionStore("overlay-session");
  for (const store of [useDashboardStore, overlay.store]) store.getState().processEvent({ type: "assistant_message", text: "기존 답", timestamp: 1 }, 1);
  vi.mocked(submitIntervention).mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await mount();
});
afterEach(() => { act(() => root.unmount()); host.remove(); useDashboardStore.getState().reset(); vi.unstubAllGlobals(); });

it("closes a same-session pending retry immediately, and a later failure leaves a newly opened line intact", async () => {
  const pending: PendingChatSend = { id: "retry-a", status: "failed", text: "다시 전송", messageText: "다시 전송", attachmentPaths: [], attachments: [], mode: "intervention", reason: "실패" };
  await act(async () => useDashboardStore.getState().setPendingChatSend("main-session", pending));
  let reject!: (error: Error) => void;
  vi.mocked(submitIntervention).mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  await click("main", "안내 열기"); expect(notice("main")).not.toBeNull();
  await click("main", "다시 보내기"); expect(notice("main")).toBeNull();
  expect(submitIntervention).toHaveBeenCalledTimes(1);
  await click("main", "안내 열기");
  await act(async () => reject(new Error("fixture failure")));
  expect(notice("main")?.textContent).toBe("기본값으로 돌아갔어");
});

it("uses the other-session overlay scope: closes on send before its response, isolates the main pane and resets on session change", async () => {
  let resolve!: (result: Awaited<ReturnType<typeof submitIntervention>>) => void;
  vi.mocked(submitIntervention).mockImplementation(() => new Promise(done => { resolve = done; }));
  await click("main", "안내 열기"); await click("overlay", "안내 열기"); await type("overlay", "overlay 초안");
  await act(async () => pane("overlay").querySelector<HTMLButtonElement>('[data-testid="send-button"]')!.click());
  expect(pane("overlay").querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("");
  expect(notice("overlay")).toBeNull(); expect(notice("main")).not.toBeNull();
  expect(submitIntervention).toHaveBeenCalledWith(expect.objectContaining({ sessionKey: "overlay-session" }));
  await click("overlay", "안내 열기");
  await act(async () => resolve({ ok: true, delivered: true, reason: null, consumeWhen: null }));
  expect(notice("overlay")?.textContent).toBe("기본값으로 돌아갔어");
  await act(async () => overlay.store.getState().setActiveSession("overlay-next"));
  expect(notice("overlay")).toBeNull(); expect(notice("main")).not.toBeNull();
});
