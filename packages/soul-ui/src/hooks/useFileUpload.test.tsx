/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFileUpload, type UseFileUploadReturn } from "./useFileUpload";
import {hasPendingDashboardMutations} from "../pending-mutation-registry";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let latest: UseFileUploadReturn;
function Harness({ url, sessionId }: { url: string; sessionId: string }) {
  latest = useFileUpload({ uploadUrl: url, sessionId });
  return null;
}
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(r => { resolve = r; });
  return { promise, resolve };
}
const response = (path: string) => ({ ok: true, json: async () => ({ path }) }) as Response;
describe("upload destination changes", () => {
  let root: Root, container: HTMLDivElement;
  const requests: Array<{ url: string; options: RequestInit; result: ReturnType<typeof deferred> }> = [];
  beforeEach(() => {
    container = document.createElement("div"); root = createRoot(container); requests.length = 0;
    vi.stubGlobal("fetch", vi.fn((url: string, options: RequestInit) => {
      const result = deferred(); requests.push({ url, options, result }); return result.promise;
    }));
  });
  afterEach(async () => { await act(() => root.unmount()); vi.unstubAllGlobals(); });
  const render = async (url: string, sessionId = "draft") => { await act(() => root.render(createElement(Harness, { url, sessionId }))); };
  const add = async () => { const file = new File(["image"], "capture.png", { type: "image/png" }); await act(() => latest.addFiles([file])); return file; };
  const finish = async (index: number, path: string) => { await act(async () => { requests[index].result.resolve(response(path)); }); };
  it("invalidates A paths, reuploads the same File to B, and only then becomes ready", async () => {
    await render("/upload?nodeId=A"); const file = await add(); await finish(0, "/A/image.png");
    expect(latest.uploadedPaths).toEqual(["/A/image.png"]);
    await render("/upload?nodeId=B");
    expect(latest.uploadedPaths).toEqual([]); expect(latest.isUploading).toBe(true);
    expect(requests[1].url).toBe("/upload?nodeId=B");
    expect(latest.files[0].file).toBe(file);
    expect((requests[1].options.body as FormData).get("session_id")).toBe("draft");
    await finish(1, "/B/image.png"); expect(latest.uploadedPaths).toEqual(["/B/image.png"]);
  });
  it("ignores a slow A response, including after the destination goes A to B to A", async () => {
    await render("/A"); await add(); const signal = requests[0].options.signal!;
    await render("/B"); expect(signal.aborted).toBe(true);
    await render("/A"); await finish(2, "/A/new.png"); await finish(0, "/A/old.png"); await finish(1, "/B/image.png");
    expect(latest.uploadedPaths).toEqual(["/A/new.png"]);
  });
  it("retains the original File after a B failure and exposes no submitted path", async () => {
    await render("/A"); const file = await add(); await finish(0, "/A/image.png"); await render("/B");
    await act(async () => { requests[1].result.resolve({ ok: false, status: 500 } as Response); });
    expect(latest.files[0]).toMatchObject({ file, path: null, status: "error" });
    expect(latest.uploadedPaths).toEqual([]);
  });
  it("does not move attachments into another active session", async () => {
    await render("/A", "session-1"); await add(); await render("/B", "session-2");
    expect(requests).toHaveLength(1); expect(requests[0].options.signal!.aborted).toBe(true);
    await finish(0, "/A/old.png"); expect(latest.files).toEqual([]);
  });
  it("restores retry attachments without source metadata at the current destination", async () => {
    await render("/A"); const file = new File(["png"], "retry.png", { type: "image/png" });
    await act(() => latest.restoreUploadedFiles([{ id: "retry", file, path: "/A/retry.png", status: "done" }]));
    expect(latest.uploadedPaths).toEqual(["/A/retry.png"]); expect(requests).toHaveLength(0);
    await act(() => latest.removeFile("retry")); expect(latest.files).toEqual([]);
  });
  it("protects selected attachments during upload and after completion until removed",async()=>{
    await render("/A");await add();expect(hasPendingDashboardMutations()).toBe(true);
    await finish(0,"/A/image.png");expect(hasPendingDashboardMutations()).toBe(true);
    await act(()=>latest.removeFile(latest.files[0].id));expect(hasPendingDashboardMutations()).toBe(false);
  });
});
