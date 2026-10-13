/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatInput } from "./ChatInput";
import { createChatSessionStore, useDashboardStore } from "../stores/dashboard-store";
import { ChatStoreScopeProvider } from "../stores/chat-store-scope";
import type { ChatUiComposerHandle } from "./chat-ui/chat-ui-composer";
import type { UseChatInputSendArgs } from "./chat/useChatInputSend";

const sendState = vi.hoisted(() => ({ sending: false, send: vi.fn(), args: null as UseChatInputSendArgs | null }));
vi.mock("./chat/useChatInputSend", () => ({ useChatInputSend: (args: UseChatInputSendArgs) => {
  sendState.args = args;
  return { sending: sendState.sending, send: sendState.send, retry: vi.fn(), reset: vi.fn(), error: null };
} }));
vi.mock("../hooks/useFileUpload", () => ({ useFileUpload: () => ({
  files: [{ id: "file-a", file: new File(["note"], "메모.pdf"), status: "done", path: "/fixture/note.pdf" }],
  isUploading: true, isReady: false, addFiles: vi.fn(), removeFile: vi.fn(), resetLocal: vi.fn(), restoreUploadedFiles: vi.fn(), uploadedPaths: ["/fixture/note.pdf"],
}) }));
vi.mock("./LiquidGlassProvider", () => ({ useGlassSurface: () => false }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let host: HTMLDivElement;
let handle: ChatUiComposerHandle | null;
let scope: ReturnType<typeof createChatSessionStore>;
const register = (value: ChatUiComposerHandle | null) => { handle = value; };
const editor = () => host.querySelector<HTMLTextAreaElement>("textarea")!;
const undo = () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "되돌리기");
async function render(disabled = false) {
  await act(async () => root.render(<ChatStoreScopeProvider scope={scope}><ChatInput fileUploadUrl="/fixture/upload" additionalDisabled={disabled} registerGeneratedTextActions={register} /></ChatStoreScopeProvider>));
}
async function edit(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor(), text);
    editor().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(async () => {
  useDashboardStore.getState().reset();
  scope = createChatSessionStore("s1"); handle = null; sendState.sending = false; sendState.send.mockClear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await render();
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
it("appends to the latest untrimmed draft, focuses its end, preserves upload/mode and never sends", async () => {
  await edit("  쓰던 글\n");
  const mode = host.querySelector('[data-slot="chat-input-mode"]')?.textContent;
  await act(async () => expect(handle!.appendGeneratedText("s1", "생성 글")).toEqual({ ok: true }));
  expect(editor().value).toBe("  쓰던 글\n\n\n생성 글");
  expect(useDashboardStore.getState().drafts.s1).toBe(editor().value);
  expect(document.activeElement).toBe(editor());
  expect(editor().selectionStart).toBe(editor().value.length);
  expect(editor().selectionEnd).toBe(editor().value.length);
  expect(host.textContent).toContain("메모.pdf");
  expect(host.querySelector('[data-slot="chat-input-mode"]')?.textContent).toBe(mode);
  expect(sendState.send).not.toHaveBeenCalled();
  await act(async () => undo()!.click());
  expect(editor().value).toBe("  쓰던 글\n"); expect(undo()).toBeUndefined();
  expect(document.activeElement).toBe(editor()); expect(editor().selectionEnd).toBe(editor().value.length);
});
it("handles empty drafts and synchronous consecutive appends with one exact undo", async () => {
  await act(async () => { handle!.appendGeneratedText("s1", "첫째"); handle!.appendGeneratedText("s1", "둘째"); });
  expect(editor().value).toBe("첫째\n\n둘째");
  await act(async () => undo()!.click()); expect(editor().value).toBe("첫째"); expect(undo()).toBeUndefined();
});
it("discards undo on user editing, including editing back to the generated value", async () => {
  await act(async () => handle!.appendGeneratedText("s1", "생성"));
  await edit("생성 변경"); expect(undo()).toBeUndefined();
  await edit("생성"); expect(undo()).toBeUndefined();
});
it("clears undo at the existing send and session boundaries", async () => {
  await act(async () => handle!.appendGeneratedText("s1", "생성"));
  await act(async () => sendState.args!.onBeforeSend!("생성")); expect(undo()).toBeUndefined();
  await act(async () => handle!.appendGeneratedText("s1", "다시 생성"));
  await act(async () => scope.store.getState().setActiveSession("s2"));
  expect(editor().value).toBe(""); expect(undo()).toBeUndefined();
  await act(async () => scope.store.getState().setActiveSession("s1")); expect(undo()).toBeUndefined();
});
it("returns unavailable for a different session or disabled editor and sending for an active request", async () => {
  expect(handle!.appendGeneratedText("s2", "생성")).toEqual({ ok: false, reason: "unavailable" });
  await render(true); expect(handle!.appendGeneratedText("s1", "생성")).toEqual({ ok: false, reason: "unavailable" });
  sendState.sending = true; await render();
  expect(handle!.appendGeneratedText("s1", "생성")).toEqual({ ok: false, reason: "sending" }); expect(editor().value).toBe("");
});
