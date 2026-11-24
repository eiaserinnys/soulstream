/** @vitest-environment jsdom */
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PersistentDefaultsSettingsForm } from "./PersistentDefaultsSettingsForm";

vi.mock("./NodeModelPresetSelect", async () => {
  const React = await import("react");
  return { NodeModelPresetSelect: ({ value, label, modelPresetCatalog, onValueChange }: any) => React.createElement("label", null, label,
    React.createElement("select", { "aria-label": label, value, onChange: (e: any) => onValueChange(e.target.value) },
      React.createElement("option", { value: "" }, "미지정"),
      ...modelPresetCatalog.presets.map((p: any) => React.createElement("option", { key: p.id, value: p.id }, p.label)),
      ...(value && !modelPresetCatalog.presets.some((p: any) => p.id === value) ? [React.createElement("option", { key: value, value }, `${value} · 이 노드 목록에 없음`)] : []))) };
});
vi.mock("./CatalogSelectionField", async () => {
  const React = await import("react");
  return { CatalogSelectionField: ({ label, value, options, onValueChange }: any) => React.createElement("label", null, label,
    React.createElement("select", { "aria-label": label, value, onChange: (e: any) => onValueChange(e.target.value) },
      ...options.map((o: any) => React.createElement("option", { key: o.value, value: o.value }, o.label)))) };
});
const preset = (id: string, efforts: string[]) => ({ id, label: `모델 ${id}`, backend: "test", available: true, reason: null, reason_label: null, resets_at: null, usage_warning: false, supported_efforts: efforts });
const presets = [preset("a", ["low", "high"]), preset("b", ["medium"]), preset("c", [])];
const value = { model_preset: "a", fallback_models: [{ model_preset: "b", reasoning_effort: "medium" }, { model_preset: "c", reasoning_effort: null }] };
const payload = { value, version: 7, source: "settings" };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let root: Root;
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
async function mount(fetcher: typeof fetch) {
  vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  flushSync(() => root.render(createElement(PersistentDefaultsSettingsForm))); await settle();
}
function button(text: string) { const result = [...document.querySelectorAll("button")].find((b) => b.textContent === text); expect(result).toBeDefined(); return result!; }
function click(text: string) { flushSync(() => button(text).click()); }
function change(label: string, value: string) { const select = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!; expect(select).toBeTruthy(); flushSync(() => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); }); }
function mockFetch(options: { failCatalog?: boolean; writeStatus?: number } = {}) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (path === "/api/persistent-sessions") return response({ sessions: [], total: 0, create_defaults: { node_id: "default-node" } });
    if (path === "/api/nodes/default-node/model-presets") return options.failCatalog ? response({}, 503) : response({ model_presets: presets });
    if (path === "/api/admin/settings/persistent-defaults" && init?.method === "PUT") return options.writeStatus ? response({ detail: { error: { message: "서버 값 오류" } } }, options.writeStatus) : response({ ...payload, value: JSON.parse(String(init.body)).value, version: 8 });
    if (path === "/api/admin/settings/persistent-defaults") return response(payload);
    throw new Error(`예상 밖 요청: ${path}`);
  });
}
afterEach(() => { if (root) flushSync(() => root.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); });

it("기본 노드 목록을 읽고 순서와 노력을 바꿔 버전과 함께 저장한다", async () => {
  const fetcher = mockFetch(); await mount(fetcher as typeof fetch);
  expect(fetcher.mock.calls.some(([url]) => url === "/api/nodes/default-node/model-presets")).toBe(true);
  expect(document.body.textContent).toContain("설정에 저장됨");
  expect(button("기본 모델 저장").disabled).toBe(true);
  click("2순위 위로"); change("2순위 노력", ""); click("대체 모델 추가");
  change("3순위 모델", "a"); change("3순위 노력", "high");
  expect(button("대체 모델 추가").disabled).toBe(true);
  click("기본 모델 저장"); await settle();
  const write = fetcher.mock.calls.find(([url, init]) => url === "/api/admin/settings/persistent-defaults" && init?.method === "PUT")!;
  expect(JSON.parse(String(write[1]?.body))).toEqual({ expectedVersion: 7, value: { model_preset: "a", fallback_models: [
    { model_preset: "c", reasoning_effort: null }, { model_preset: "b", reasoning_effort: null }, { model_preset: "a", reasoning_effort: "high" },
  ] } });
  expect(button("기본 모델 저장").disabled).toBe(true);
});
it("충돌을 알리고 다시 불러올 수 있다", async () => {
  const fetcher = mockFetch({ writeStatus: 409 }); await mount(fetcher as typeof fetch);
  click("1순위 제거"); click("기본 모델 저장"); await settle();
  expect(document.body.textContent).toContain("다른 곳에서 먼저 바뀌었습니다");
  click("다시 불러오기"); await settle();
  expect(document.body.textContent).not.toContain("다른 곳에서 먼저 바뀌었습니다");
  expect(button("기본 모델 저장").disabled).toBe(true);
});
it("422 오류 문구를 보이고 초안을 보존한다", async () => {
  await mount(mockFetch({ writeStatus: 422 }) as typeof fetch); click("1순위 제거"); click("기본 모델 저장"); await settle();
  expect(document.body.textContent).toContain("서버 값 오류");
  expect(button("기본 모델 저장").disabled).toBe(false);
});
it("목록 조회 실패의 까닭을 보이고 저장을 막는다", async () => {
  await mount(mockFetch({ failCatalog: true }) as typeof fetch);
  expect(document.body.textContent).toContain("모델 목록을 불러오지 못했습니다 (503)");
  expect(button("기본 모델 저장").disabled).toBe(true);
});
