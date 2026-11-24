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
it("advertises the preset used by the persistent session sample", async () => {
  const api = createDialoguesApi();
  const sessions = await (await api.request("/api/persistent-sessions")).json();
  const catalog = await (await api.request("/api/nodes/sample-node/model-presets")).json();
  const presetId = sessions.sessions[0].settings.default_model.model_preset;
  expect(catalog.model_presets).toContainEqual(expect.objectContaining({ id: presetId, label: "Sample A" }));
});
it("preserves the empty usage node and adds a separate three-provider usage node", async () => {
  const api = createDialoguesApi();
  expect(api.config.nodes.has("sample-node")).toBe(true);
  expect(await (await api.request("/api/nodes/sample-node/provider-usage")).json()).toEqual({ providers: [] });
  expect(api.config.nodes.has("sample-usage-node")).toBe(true);
  const usage = await (await api.request("/api/nodes/sample-usage-node/provider-usage")).json();
  expect(Object.keys(usage.providers)).toEqual(["claude", "codex", "antigravity"]);
  expect(usage.providers.antigravity.quotas.map((quota: { label: string; window: string }) => [quota.label, quota.window])).toEqual([["5시간", "5h"], ["7일", "7d"]]);
});
it("returns the assembly contract for central and node-only profiles", async () => {
  const api = createDialoguesApi();
  const profiles = await (await api.request("/api/agent-profiles")).json();
  const bundles = await (await api.request("/api/context-bundles")).json();
  const specs = [...bundles.bundles.flatMap((bundle: { atom_contexts: unknown[] }) => bundle.atom_contexts), ...profiles.profiles[0].atom_contexts];
  const preview = async (body: unknown) => (await api.request("/api/nodes/sample-node/agents/context-preview", { method: "POST", body: JSON.stringify(body) })).json();
  const result = await preview({ atom_contexts: specs, session: { backend: "claude" } });
  expect(result.sections).toHaveLength(specs.length);
  expect(result.manifest.sources.map((source: {status: string}) => source.status)).toEqual(["ok", "ok", "filtered", "error", "ok"]);
  expect(result.sections[0].markdown.length).toBeGreaterThan(50000);
  expect(result.assembled).toContain(result.sections[0].markdown);
  const included = await preview({ agent_id: "node-sample", session: { backend: "codex", card_role: "assignee" } });
  expect(included.manifest.sources[2].status).toBe("ok");
  const agents = await (await api.request("/api/nodes/sample-node/agents")).json();
  expect(agents.agents).toContainEqual(expect.objectContaining({ id: "node-sample", source: "yaml" }));
});
it("keeps the failure scene failing until the scene is changed for retry", async () => {
  history.replaceState(null, "", "/dialogues?sample=settings&assemblyState=retry");
  const api = createDialoguesApi();
  const request = () => api.request("/api/nodes/sample-node/agents/context-preview", {
    method: "POST", body: JSON.stringify({ atom_contexts: [], session: { source: "browser" } }),
  });
  expect((await request()).status).toBe(503);
  expect((await request()).status).toBe(503);
  history.replaceState(null, "", "/dialogues?sample=settings&assemblyState=normal");
  expect((await request()).status).toBe(200);
  history.replaceState(null, "", "/");
});
