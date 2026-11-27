/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatInput } from "./ChatInput";
import { createChatSessionStore, useDashboardStore } from "../stores/dashboard-store";
import { ChatStoreScopeProvider } from "../stores/chat-store-scope";

vi.mock("./LiquidGlassProvider", () => ({ useGlassSurface: () => false }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;

const editor = () => host.querySelector<HTMLTextAreaElement>("textarea")!;
const sendButton = () => host.querySelector<HTMLButtonElement>('[data-testid="send-button"]')!;
const modeTitle = () => host.querySelector('[data-slot="chat-input-mode"]')?.getAttribute("title");

async function mount(sessionType: "llm" | "claude", status: string) {
  const scope = createChatSessionStore("s1");
  scope.store.setState({
    activeSessionKey: "s1",
    activeSessionSummary: { agentSessionId: "s1", status, sessionType } as never,
  });
  await act(async () => root.render(
    <ChatStoreScopeProvider scope={scope}>
      <ChatInput fileUploadUrl="/fixture/upload" />
    </ChatStoreScopeProvider>,
  ));
}

async function type(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor(), text);
    editor().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  useDashboardStore.getState().reset();
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ type: "intervene_ack", status: "ok", outcome: "auto_resumed", delivered: true }),
    text: async () => "",
  });
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("끝난 llm 세션은 끝난 claude 세션과 같은 이어 쓰기 안내를 보인다", async () => {
  await mount("llm", "completed");

  expect(editor().placeholder).toBe("대화를 이어서 입력하세요");
  expect(modeTitle()).toBe("대화 이어가기");
  expect(sendButton().getAttribute("aria-label")).toBe("보내기");
  expect(host.innerHTML).not.toContain("LLM (맥락");
  expect(host.innerHTML).not.toContain("맥락으로 보냅니다");
});

it("끝난 llm 세션에서 보내면 intervene 길로 가고 llm completions를 부르지 않는다", async () => {
  await mount("llm", "error");
  await type("더 짧게");
  await act(async () => sendButton().click());

  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const urls = fetchMock.mock.calls.map(([url]) => String(url));
  expect(urls).toEqual(["/api/sessions/s1/intervene"]);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ text: "더 짧게" });
  expect(urls.some((url) => url.includes("/api/llm/completions"))).toBe(false);
  expect(useDashboardStore.getState().pendingChatSends.s1).toMatchObject({ mode: "resume" });
});

it("끝난 llm 세션은 첨부 단추를 막고 끝난 claude 세션은 그대로 연다", async () => {
  await mount("llm", "completed");
  expect(host.querySelector('input[type="file"]')).toBeNull();
  const llmButtons = host.querySelectorAll("button").length;

  await mount("claude", "completed");
  expect(host.querySelector('input[type="file"]')).not.toBeNull();
  expect(host.querySelectorAll("button").length).toBeGreaterThan(llmButtons);
});
