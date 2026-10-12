/** @vitest-environment jsdom */
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DocumentReaderDialog } from "./DocumentReaderDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); vi.unstubAllGlobals(); });
async function mount(request: typeof fetch) {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<DocumentReaderDialog documentId="doc-1" request={request} onClose={() => {}}/>));
}
it("shows the title and read-only body without a duplicate leading heading", async () => {
  await mount(vi.fn(async () => Response.json({ id: "doc-1", title: "문서 제목", body: "# 문서 제목\n\n읽는 본문", version: 1 })));
  expect(document.querySelector('[data-slot="dialog-title"]')?.textContent).toBe("문서 제목");
  expect(document.querySelector('[data-testid="internal-document-dialog"]')?.classList.contains("v3-document-reader-dialog")).toBe(true);
  expect(document.querySelector('button[aria-label="문서 닫기"]')).not.toBeNull();
  expect(document.querySelector('[data-slot="dialog-header"]')?.classList.contains("pe-14")).toBe(true);
  expect(document.querySelector('.v3-folder-board-document-copy')?.textContent).toContain("읽는 본문");
  expect(document.querySelector('.v3-folder-board-document-copy h1')).toBeNull();
  expect(document.querySelector('input, textarea, [contenteditable="true"]')).toBeNull();
  const panel = document.querySelector('[role="region"][aria-label="문서 본문"]');
  expect(panel?.getAttribute("tabindex")).toBe("0");
});
it("opens a loading dialog before the response arrives", async () => {
  await mount(vi.fn(() => new Promise<Response>(() => {})));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.querySelector('.v3-board-load-state p')?.textContent).toBe("본문을 불러오는 중…");
  expect(document.querySelector('[data-slot="dialog-header"]')).not.toBeNull();
  expect(document.querySelector('[data-slot="dialog-title"]')?.classList.contains("min-h-7")).toBe(true);
  expect(document.querySelector('[data-slot="dialog-title"]')?.classList.contains("leading-7")).toBe(true);
  expect(document.querySelector('[data-slot="dialog-title"] .sr-only')?.textContent).toBe("문서");
});
it.each([404, 500])("shows a fixed message for HTTP %s", async (status) => {
  await mount(vi.fn(async () => new Response("internal failure", { status })));
  expect(document.querySelector('.v3-board-load-state p')?.textContent).toBe(status === 404 ? "문서를 찾을 수 없습니다" : "문서를 불러오지 못했습니다");
  expect(document.querySelector('[data-slot="dialog-title"] .sr-only')?.textContent).toBe("문서");
});
it("does not paint the previous document before loading a different document", async () => {
  const request = vi.fn(async () => Response.json({ id: "doc-1", title: "이전 문서", body: "이전 본문", version: 1 }));
  await mount(request);
  const commits: string[] = [];
  function ObserveCommit() {
    useLayoutEffect(() => { commits.push(document.querySelector('[data-slot="dialog-title"]')?.textContent ?? ""); });
    return null;
  }
  await act(async () => root.render(<><DocumentReaderDialog documentId="doc-2" request={() => new Promise<Response>(() => {})} onClose={() => {}}/><ObserveCommit/></>));
  expect(commits).not.toContain("이전 문서");
  expect(document.querySelector('.v3-board-load-state p')?.textContent).toBe("본문을 불러오는 중…");
});
it("keeps a successful document visible when reopening and replaces it with the refreshed response", async () => {
  let resolveRefresh!: (response: Response) => void;
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ id: "doc-1", title: "문서 제목", body: "이전 본문", version: 1 }))
    .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveRefresh = resolve; }));
  await mount(request);
  await act(async () => root.render(<DocumentReaderDialog documentId={null} request={request} onClose={() => {}}/>));
  const loading: boolean[] = [];
  const observer = new MutationObserver(() => loading.push(!!document.querySelector('.v3-board-load-state')));
  observer.observe(document.body, { childList: true, subtree: true });
  try {
    await act(async () => root.render(<DocumentReaderDialog documentId="doc-1" request={request} onClose={() => {}}/>));
    expect(request).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-slot="dialog-title"]')?.textContent).toBe("문서 제목");
    expect(document.querySelector('.v3-folder-board-document-copy')?.textContent).toContain("이전 본문");
    expect(document.querySelector('.v3-board-load-state')).toBeNull();
    await act(async () => resolveRefresh(Response.json({ id: "doc-1", title: "갱신한 제목", body: "갱신한 본문", version: 2 })));
    expect(document.querySelector('[data-slot="dialog-title"]')?.textContent).toBe("갱신한 제목");
    expect(document.querySelector('.v3-folder-board-document-copy')?.textContent).toContain("갱신한 본문");
    expect(loading).not.toContain(true);
  } finally { observer.disconnect(); }
});
it("starts loading again when reopening a document whose previous request failed", async () => {
  let resolveRefresh!: (response: Response) => void;
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveRefresh = resolve; }));
  await mount(request);
  expect(document.querySelector('.v3-board-load-state p')?.textContent).toBe("문서를 찾을 수 없습니다");
  await act(async () => root.render(<DocumentReaderDialog documentId={null} request={request} onClose={() => {}}/>));
  await act(async () => root.render(<DocumentReaderDialog documentId="doc-1" request={request} onClose={() => {}}/>));
  expect(request).toHaveBeenCalledTimes(2);
  expect(document.querySelector('.v3-board-load-state p')?.textContent).toBe("본문을 불러오는 중…");
  await act(async () => resolveRefresh(new Response(null, { status: 404 })));
  expect(document.querySelector('.v3-board-load-state p')?.textContent).toBe("문서를 찾을 수 없습니다");
});
