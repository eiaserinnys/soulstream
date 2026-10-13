/** @vitest-environment jsdom */
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { FileStorageTab } from "../components/FileStorageTab";
import { createDialoguesApi } from "./dialogues-api";
let root: ReturnType<typeof createRoot>;
afterEach(() => { if (root) flushSync(() => root.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); });
async function settle() { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)); }
it("uses the supplied read/write port and retains the production endpoint contract", async () => {
  const backend = vi.fn(() => { throw new Error("backend must not be called"); });
  vi.stubGlobal("fetch", backend);
  const api = createDialoguesApi();
  const request = vi.fn(api.request);
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  flushSync(() => root.render(createElement<{request?: typeof fetch}>(FileStorageTab, { request }))); await settle();
  const section = container.querySelector("section")!;
  flushSync(() => Array.from(section.querySelectorAll("button")).find(button => button.textContent === "저장")!.click()); await settle();
  expect(request.mock.calls.map(call => [String(call[0]), call[1]?.method ?? "GET"])).toContainEqual(["/api/admin/settings/board-r2", "PUT"]);
  expect(backend).not.toHaveBeenCalled();
});
it("keeps fixture mutations local and refuses unimplemented endpoints", async () => {
  const api = createDialoguesApi();
  await api.request("/api/admin/users", { method: "POST", body: JSON.stringify({ email: "new@sample.invalid", displayName: "새 사용자", isAdmin: false, allowedFolderIds: [] }) });
  const saved = await (await api.request("/api/admin/users")).json();
  expect(saved.users.some((user: {email:string}) => user.email === "new@sample.invalid")).toBe(true);
  await expect(api.request("/api/unimplemented", {method:"DELETE"})).rejects.toThrow("샘플 API");
});
it("preserves the empty usage node and adds a separate three-provider usage node", async () => {
  const api = createDialoguesApi();
  expect(api.config.nodes.has("sample-node")).toBe(true);
  expect(await (await api.request("/api/nodes/sample-node/provider-usage")).json()).toEqual({ providers: [] });
  expect(api.config.nodes.has("sample-usage-node")).toBe(true);
  const usage = await (await api.request("/api/nodes/sample-usage-node/provider-usage")).json();
  expect(Object.keys(usage.providers)).toEqual(["claude", "codex", "antigravity"]);
  expect(usage.providers.antigravity.quotas.map((quota: { label: string; window: string }) => [quota.label, quota.window])).toEqual([["7일", "7d"], ["5시간", "5h"]]);
});
