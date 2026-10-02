/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CardCommentInput } from "./CardCommentInput";
import { ChatInput } from "@seosoyoung/soul-ui/components/ChatInput";
import { useDashboardStore } from "@seosoyoung/soul-ui/stores/dashboard-store";
vi.mock("@seosoyoung/soul-ui/providers/AuthProvider", () => ({ useAuth: () => ({ user: null, isAuthenticated: false }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  useDashboardStore.getState().reset(); useDashboardStore.getState().setActiveSession("session-1");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ path: "/A/clipboard.png" }) }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  URL.createObjectURL = vi.fn(() => "blob:test"); URL.revokeObjectURL = vi.fn();
});
afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
function paste(files: File[]) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files, items: files.map(file => ({ kind: "file", type: file.type, getAsFile: () => file })) } });
  container.querySelector("textarea")!.dispatchEvent(event); return event;
}
describe("production input clipboard events", () => {
  it.each(["comment", "chat"])("uploads a pasted image in the %s input and preserves text paste", async surface => {
    await act(() => root.render(surface === "comment"
      ? <CardCommentInput cardId="paste-card" nodeId="A" sessionId="session-1" pending={false} onSend={async () => true}/>
      : <ChatInput fileUploadUrl="/api/attachments/sessions?nodeId=A"/>));
    let textPaste!: Event; await act(() => { textPaste = paste([]); }); expect(textPaste.defaultPrevented).toBe(false);
    const image = new File(["image"], "image.png", { type: "image/png" });
    let imagePaste!: Event; await act(async () => { imagePaste = paste([image]); });
    expect(imagePaste.defaultPrevented).toBe(true);
    const upload = vi.mocked(fetch).mock.calls.find(([url]) => String(url).includes("/attachments/sessions"));
    expect(upload).toBeDefined();
    expect((upload![1]!.body as FormData).get("session_id")).toBe("session-1");
    const uploaded = (upload![1]!.body as FormData).get("file") as File;
    expect(uploaded.name).toMatch(/^clipboard-.+\.png$/);
    expect(container.querySelector('img[src="blob:test"]')).not.toBeNull();
  });
});
