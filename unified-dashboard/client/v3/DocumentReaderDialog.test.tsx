/** @vitest-environment jsdom */
import { act } from "react";
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
  expect(document.querySelector('.v3-folder-board-document-copy')?.textContent).toContain("읽는 본문");
  expect(document.querySelector('.v3-folder-board-document-copy h1')).toBeNull();
  expect(document.querySelector('input, textarea, [contenteditable="true"]')).toBeNull();
});
it("opens a loading dialog before the response arrives", async () => {
  await mount(vi.fn(() => new Promise<Response>(() => {})));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.querySelector('.v3-detail-empty')?.textContent).toBe("본문을 불러오는 중…");
  expect(document.querySelector('[data-slot="dialog-title"]')?.classList.contains("sr-only")).toBe(true);
});
it.each([404, 500])("shows a fixed message for HTTP %s", async (status) => {
  await mount(vi.fn(async () => new Response("internal failure", { status })));
  expect(document.querySelector('.v3-inline-board-error')?.textContent).toBe(status === 404 ? "문서를 찾을 수 없습니다" : "문서를 불러오지 못했습니다");
});
