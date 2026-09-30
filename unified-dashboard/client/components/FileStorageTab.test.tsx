/** @vitest-environment jsdom */
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { FileStorageTab } from "./FileStorageTab";
const metadata = { endpoint: "", bucket: "", accessKeyId: "", secretAccessKeyConfigured: true, version: 2 };
let root: ReturnType<typeof createRoot>;
afterEach(() => { if (root) flushSync(() => root.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); });
async function settle() { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)); }
function change(input: HTMLInputElement, value: string) { flushSync(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }); }
function click(section: Element, text: string) { const button = Array.from(section.querySelectorAll("button")).find(b => b.textContent === text)!; flushSync(() => button.click()); }
it("uses independent forms, retains blank secrets, clears saved secrets and explicitly deletes them", async () => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify({ ...metadata, version: init?.method === "PUT" ? 3 : 2 })));
  vi.stubGlobal("fetch", fetchMock);
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  flushSync(() => root.render(createElement(FileStorageTab))); await settle();
  const sections = container.querySelectorAll("section"); expect(sections).toHaveLength(2);
  expect(sections[0]!.textContent).toContain("보드 파일"); expect(sections[1]!.textContent).toContain("세션 첨부");
  const password = sections[0]!.querySelector<HTMLInputElement>('input[type="password"]')!; expect(password.value).toBe("");
  click(sections[0]!, "저장"); await settle();
  expect(JSON.parse(String(fetchMock.mock.calls[2]![1]!.body))).not.toHaveProperty("secretAccessKey");
  change(password, "new-secret"); click(sections[0]!, "저장"); await settle();
  expect(JSON.parse(String(fetchMock.mock.calls[3]![1]!.body))).toMatchObject({ secretAccessKey: "new-secret", expectedVersion: 3 }); expect(password.value).toBe("");
  const checkbox = sections[0]!.querySelector<HTMLInputElement>('input[type="checkbox"]')!; flushSync(() => checkbox.click()); click(sections[0]!, "저장"); await settle();
  expect(JSON.parse(String(fetchMock.mock.calls[4]![1]!.body))).toMatchObject({ secretAccessKey: "" });
  click(sections[1]!, "연결 확인"); await settle(); expect(fetchMock.mock.calls[5]![0]).toBe("/api/admin/settings/attachment-r2/check");
});
