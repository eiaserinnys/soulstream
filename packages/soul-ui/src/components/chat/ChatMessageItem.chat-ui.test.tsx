/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../lib/flatten-tree";
import { ChatMessageItem } from "./ChatMessageItem";
import { ChatUiControllerProvider, useChatUiHost } from "../chat-ui/ChatUiControllerProvider";
import { envelope } from "../chat-ui/chat-ui.test-fixture";

const observation = vi.hoisted(() => ({ ordinaryRenders: 0, broken: false }));
vi.mock("./AssistantMessage", async importOriginal => {
  const original = await importOriginal<typeof import("./AssistantMessage")>();
  return { AssistantMessage: (props: Parameters<typeof original.AssistantMessage>[0]) => {
    if (props.msg.id === "ordinary") observation.ordinaryRenders++;
    return <original.AssistantMessage {...props} />;
  } };
});
vi.mock("../chat-ui/ChatUiRenderer", async importOriginal => {
  const original = await importOriginal<typeof import("../chat-ui/ChatUiRenderer")>();
  return { ChatUiRenderer: (props: Parameters<typeof original.ChatUiRenderer>[0]) => {
    if (observation.broken && props.doc.title === "broken") throw new Error("one message failed");
    return <original.ChatUiRenderer {...props} />;
  } };
});
vi.mock("../LiquidGlassProvider", () => ({ useGlassSurface: () => false }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
let root: Root; let host: HTMLDivElement;
afterEach(() => { act(() => root.unmount()); host.remove(); observation.broken = false; vi.restoreAllMocks(); });
const message = (id: string, ui?: unknown): ChatMessage => ({ id, role: "assistant", treeNodeId: id, treeNodeType: "assistant_message", content: "**기존 답**", timestamp: 1, ui });
const ordinary = message("ordinary"); const rich = message("rich", envelope);
function Notice() { return <output>{useChatUiHost().feedback}</output>; }
async function mount(children: React.ReactNode) {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<ChatUiControllerProvider sessionId="s1">{children}<Notice /></ChatUiControllerProvider>));
}
async function click(label: string, within: Element = host) {
  const button = Array.from(within.querySelectorAll("button")).find(b => b.textContent === label)!;
  expect(button).toBeTruthy(); await act(async () => button.click());
}
it("renders UI in the actual message branch and isolates ordinary rows from values and feedback", async () => {
  observation.ordinaryRenders = 0;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  await mount(<><ChatMessageItem msg={ordinary} /><ChatMessageItem msg={rich} /></>);
  const count = observation.ordinaryRenders;
  expect(host.querySelector('[data-tree-node-id="ordinary"] strong')?.textContent).toBe("기존 답");
  expect(host.querySelector('[data-tree-node-id="rich"] [data-slot="chat-message-bubble"]')?.classList.contains("w-full")).toBe(true);
  await click("12명으로"); await click("복사");
  expect(host.querySelector("output")?.textContent).toBe("현재 값 복사됨");
  expect(observation.ordinaryRenders).toBe(count);
  await click("초기화"); expect(observation.ordinaryRenders).toBe(count);
});
it("contains one render failure while the other message and publication state stay usable", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const broken = message("broken", { ...envelope, ui_id: "other", document: { ...envelope.document, title: "broken" } });
  await mount(<><ChatMessageItem msg={rich} /><ChatMessageItem msg={broken} /></>);
  const good = host.querySelector('[data-tree-node-id="rich"]')!;
  await click("12명으로", good); observation.broken = true;
  await click("초기화", host.querySelector('[data-tree-node-id="broken"]')!);
  expect(host.querySelector('[data-tree-node-id="broken"]')?.textContent).toContain("화면을 표시하지 못했어.");
  expect(good.querySelector('input[type="number"]')?.getAttribute("value")).toBe("12");
  await click("질문", good); expect(host.querySelector("output")?.textContent).toBe("지금은 입력창에 더할 수 없어.");
});
it("changes real choice options and retains fields across row remount but resets at session change", async () => {
  await mount(<ChatMessageItem msg={rich} />);
  await act(async () => host.querySelector<HTMLButtonElement>('[data-slot="select-trigger"]')!.click());
  const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(node => node.textContent?.includes("웹 먼저"))!;
  expect(option).toBeTruthy();
  // Base UI commits only its highlighted option; browser clicks focus it first.
  await act(async () => option.focus());
  await act(async () => option.click());
  expect(host.querySelector('[data-slot="select-trigger"]')?.textContent).toContain("웹 먼저");
  await act(async () => root.render(<ChatUiControllerProvider sessionId="s1"><Notice /></ChatUiControllerProvider>));
  await act(async () => root.render(<ChatUiControllerProvider sessionId="s1"><ChatMessageItem msg={rich} /><Notice /></ChatUiControllerProvider>));
  expect(host.querySelector('[data-slot="select-trigger"]')?.textContent).toContain("웹 먼저");
  await act(async () => root.render(<ChatUiControllerProvider sessionId="s2"><ChatMessageItem msg={rich} /><Notice /></ChatUiControllerProvider>));
  expect(host.querySelector('[data-slot="select-trigger"]')?.textContent).toContain("앱 먼저");
});
