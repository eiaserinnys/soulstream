/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatInput } from "./ChatInput";
import { PersistentReportProvider } from "./persistent-report/PersistentReportProvider";
import { createChatSessionStore, useDashboardStore } from "../stores/dashboard-store";
import { ChatStoreScopeProvider } from "../stores/chat-store-scope";
import type { UseChatInputSendArgs } from "./chat/useChatInputSend";

vi.mock("./chat/useChatInputSend", () => ({ useChatInputSend: (_args: UseChatInputSendArgs) => ({
  sending: false, send: vi.fn(), retry: vi.fn(), reset: vi.fn(), error: null,
}) }));
vi.mock("../hooks/useFileUpload", () => ({ useFileUpload: () => ({
  files: [], isUploading: false, isReady: true, addFiles: vi.fn(), removeFile: vi.fn(),
  resetLocal: vi.fn(), restoreUploadedFiles: vi.fn(), uploadedPaths: [],
}) }));
vi.mock("./LiquidGlassProvider", () => ({ useGlassSurface: () => false }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let scope: ReturnType<typeof createChatSessionStore>;
let fetchMock: ReturnType<typeof vi.fn>;

async function render() {
  await act(async () => root.render(
    <ChatStoreScopeProvider scope={scope}>
      <PersistentReportProvider sessionId="s1" entries={[]}>
        <ChatInput />
      </PersistentReportProvider>
    </ChatStoreScopeProvider>,
  ));
}

function interruptButton() {
  return host.querySelector<HTMLButtonElement>('button[aria-label="Stop running conversation"]');
}

beforeEach(async () => {
  useDashboardStore.getState().reset();
  scope = createChatSessionStore("s1");
  scope.store.setState({
    activeSessionKey: "s1",
    activeSessionSummary: {
      agentSessionId: "s1",
      status: "running",
      sessionType: "claude",
    } as never,
  });
  fetchMock = vi.fn().mockResolvedValue({
    ok: false,
    status: 409,
    text: async () => JSON.stringify({ error: { code: "SESSION_NOT_RUNNING" } }),
  });
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await render();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("멈춤이 409를 받으면 원시 HTTP 문자열 대신 일상어로 알린다", async () => {
  await act(async () => interruptButton()?.click());

  await vi.waitFor(() => {
    expect(host.textContent).toContain("멈출 작업이 없습니다. 이미 끝난 세션일 수 있습니다.");
  });
  expect(host.textContent).not.toContain("HTTP 409");
});

it("멈춤이 503을 받으면 노드 연결 실패로 알린다", async () => {
  fetchMock.mockResolvedValue({ ok: false, status: 503, text: async () => "" });

  await act(async () => interruptButton()?.click());

  await vi.waitFor(() => {
    expect(host.textContent).toContain("노드에 연결하지 못해 멈추지 못했습니다. 다시 눌러 주세요.");
  });
});

it("망 예외도 연결 실패로 알린다", async () => {
  fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

  await act(async () => interruptButton()?.click());

  await vi.waitFor(() => {
    expect(host.textContent).toContain("노드에 연결하지 못해 멈추지 못했습니다. 다시 눌러 주세요.");
  });
});
