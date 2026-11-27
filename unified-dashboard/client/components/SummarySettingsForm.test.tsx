/** @vitest-environment jsdom */
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SummarySettingsForm } from "./SummarySettingsForm";

vi.mock("./NodeModelPresetSelect", async () => {
  const React = await import("react");
  return { NodeModelPresetSelect: ({ value, label, ariaLabel, modelPresetCatalog, onValueChange }: any) => React.createElement("label", null, label,
    React.createElement("select", { "aria-label": ariaLabel ?? label, value, onChange: (e: any) => onValueChange(e.target.value) },
      React.createElement("option", { value: "" }, "미지정"),
      ...modelPresetCatalog.presets.map((p: any) => React.createElement("option", { key: p.id, value: p.id }, p.label)),
      ...(value && !modelPresetCatalog.presets.some((p: any) => p.id === value) ? [React.createElement("option", { key: value, value }, `${value} · 이 노드 목록에 없음`)] : []))) };
});
const preset = (id: string, backend: string) => ({ id, label: `모델 ${id}`, backend, available: true, reason: null, reason_label: null, resets_at: null, usage_warning: false });
const presets = [preset("claude-sonnet", "claude"), preset("gemini-4-hydrogen", "antigravity"), preset("codex-5.6-luna", "codex"), preset("kimi-2", "claude")];
const selectable = ["claude-sonnet", "gemini-4-hydrogen", "codex-5.6-luna"];
const off = { turn: { enabled: false, model_presets: [] }, session: { enabled: false, model_presets: [] } };
const operating = {
  turn: { enabled: true, model_presets: ["claude-sonnet", "gemini-4-hydrogen", "codex-5.6-luna"] },
  session: { enabled: true, model_presets: ["claude-sonnet", "codex-5.6-luna"] },
};
const payloadOf = (value: unknown, version = 0) => ({ value, version, source: version === 0 ? "default" : "settings", updated_at: null, updated_by: null, selectable_preset_ids: selectable });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let root: Root;
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
async function mount(fetcher: typeof fetch) {
  vi.stubGlobal("fetch", fetcher); vi.stubGlobal("PointerEvent", MouseEvent);
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  flushSync(() => root.render(createElement(SummarySettingsForm))); await settle();
}
const button = (text: string) => { const result = [...document.querySelectorAll("button")].find((b) => b.textContent === text); expect(result).toBeDefined(); return result!; };
const click = (text: string) => flushSync(() => button(text).click());
const clickLabel = (label: string) => { const b = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!; expect(b, label).toBeTruthy(); flushSync(() => b.click()); };
const change = (label: string, value: string) => { const select = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!; expect(select, label).toBeTruthy(); flushSync(() => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); }); };
const toggle = (label: string) => { const sw = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)!; expect(sw, label).toBeTruthy(); flushSync(() => sw.click()); return sw; };
const optionsOf = (label: string) => [...document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!.options].map(option => option.value);
function mockFetch(options: { start?: unknown; version?: number; failCatalog?: boolean; failRead?: boolean; writeStatus?: number; writeMessage?: string } = {}) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (path === "/api/persistent-sessions") return response({ sessions: [], total: 0, create_defaults: { node_id: "default-node" } });
    if (path === "/api/nodes/default-node/model-presets") return options.failCatalog ? response({}, 503) : response({ model_presets: presets });
    if (path === "/api/admin/settings/summaries" && init?.method === "PUT") {
      if (options.writeStatus) return response({ detail: { error: { message: options.writeMessage ?? "서버 값 오류" } } }, options.writeStatus);
      return response(payloadOf(JSON.parse(String(init.body)).value, (options.version ?? 0) + 1));
    }
    if (path === "/api/admin/settings/summaries") return options.failRead ? response({}, 503) : response(payloadOf(options.start ?? off, options.version ?? 0));
    throw new Error(`예상 밖 요청: ${path}`);
  });
}
const writeBody = (fetcher: ReturnType<typeof mockFetch>) =>
  JSON.parse(String(fetcher.mock.calls.find(([url, init]) => url === "/api/admin/settings/summaries" && init?.method === "PUT")![1]!.body));
afterEach(() => { if (root) flushSync(() => root.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); });

it("행이 없는 기본 상태는 둘 다 꺼진 빈 목록이고, 안내 문구가 보인다", async () => {
  await mount(mockFetch() as typeof fetch);
  expect(document.querySelector('[aria-label="턴 요약 사용"]')?.getAttribute("aria-checked")).toBe("false");
  expect(document.querySelector('[aria-label="세션 요약 사용"]')?.getAttribute("aria-checked")).toBe("false");
  expect(document.querySelectorAll("select")).toHaveLength(0);
  expect(document.body.textContent).toContain("위에서부터 차례로 쓰고, 사용량 한도에 걸리거나 쓸 수 없을 때만 다음 모델로 넘어갑니다.");
  expect(document.body.textContent).toContain("턴 요약을 모아 세션 줄거리를 만듭니다. 턴 요약이 꺼져 있으면 새 재료가 쌓이지 않습니다.");
  expect(button("요약 설정 저장").disabled).toBe(true);
});

it("서버가 받는 모델만 고르게 하고, 켠 뒤 순서를 바꿔 버전과 함께 저장한다", async () => {
  const fetcher = mockFetch({ version: 3, start: operating }); await mount(fetcher as typeof fetch);
  expect(optionsOf("턴 요약 1번째 모델")).toEqual(["", "claude-sonnet", "gemini-4-hydrogen", "codex-5.6-luna"]);
  clickLabel("턴 요약 3번째 모델 위로");
  clickLabel("세션 요약 2번째 모델 제거");
  clickLabel("세션 요약 모델 추가"); change("세션 요약 2번째 모델", "gemini-4-hydrogen");
  click("요약 설정 저장"); await settle();
  expect(writeBody(fetcher)).toEqual({
    expectedVersion: 3,
    value: {
      turn: { enabled: true, model_presets: ["claude-sonnet", "codex-5.6-luna", "gemini-4-hydrogen"] },
      session: { enabled: true, model_presets: ["claude-sonnet", "gemini-4-hydrogen"] },
    },
  });
  expect(document.body.textContent).toContain("저장했습니다.");
  expect(button("요약 설정 저장").disabled).toBe(true);
  clickLabel("턴 요약 1번째 모델 제거");
  expect(document.body.textContent).not.toContain("저장했습니다.");
});

it("스위치를 켜고 모델을 넣어 저장하면 꺼진 쪽은 그대로 둔다", async () => {
  const fetcher = mockFetch(); await mount(fetcher as typeof fetch);
  clickLabel("턴 요약 모델 추가"); change("턴 요약 1번째 모델", "codex-5.6-luna"); toggle("턴 요약 사용");
  click("요약 설정 저장"); await settle();
  expect(writeBody(fetcher)).toEqual({ expectedVersion: 0, value: {
    turn: { enabled: true, model_presets: ["codex-5.6-luna"] }, session: { enabled: false, model_presets: [] },
  } });
});

it("켰는데 목록이 비었으면 저장 전에 까닭을 보이고 요청을 보내지 않는다", async () => {
  const fetcher = mockFetch(); await mount(fetcher as typeof fetch);
  toggle("세션 요약 사용"); click("요약 설정 저장"); await settle();
  expect(document.body.textContent).toContain("세션 요약: 켜려면 모델을 하나 이상 골라 주세요.");
  expect(fetcher.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  clickLabel("세션 요약 모델 추가"); toggle("세션 요약 사용"); toggle("세션 요약 사용");
  click("요약 설정 저장"); await settle();
  expect(document.body.textContent).toContain("세션 요약: 모델을 고르지 않은 칸이 있습니다.");
  expect(fetcher.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
});

it("목록은 다섯 개까지 담는다", async () => {
  await mount(mockFetch() as typeof fetch);
  for (let i = 0; i < 5; i++) clickLabel("턴 요약 모델 추가");
  expect(document.querySelectorAll('select[aria-label^="턴 요약 "]')).toHaveLength(5);
  expect(document.querySelector<HTMLButtonElement>('button[aria-label="턴 요약 모델 추가"]')!.disabled).toBe(true);
});

it("충돌을 알리고 다시 불러올 수 있다", async () => {
  const fetcher = mockFetch({ version: 2, start: operating, writeStatus: 409 }); await mount(fetcher as typeof fetch);
  clickLabel("턴 요약 1번째 모델 제거"); click("요약 설정 저장"); await settle();
  expect(document.body.textContent).toContain("다른 곳에서 먼저 바뀌었습니다");
  click("다시 불러오기"); await settle();
  expect(document.body.textContent).not.toContain("다른 곳에서 먼저 바뀌었습니다");
  expect(button("요약 설정 저장").disabled).toBe(true);
});

it("400 오류 문구를 보이고 초안을 보존한다", async () => {
  await mount(mockFetch({ version: 2, start: operating, writeStatus: 400, writeMessage: "턴 요약: 같은 모델을 두 번 넣을 수 없습니다 (claude-sonnet)." }) as typeof fetch);
  clickLabel("턴 요약 3번째 모델 제거"); click("요약 설정 저장"); await settle();
  expect(document.body.textContent).toContain("턴 요약: 같은 모델을 두 번 넣을 수 없습니다 (claude-sonnet).");
  expect(button("요약 설정 저장").disabled).toBe(false);
  expect(optionsOf("턴 요약 1번째 모델").length).toBeGreaterThan(0);
  expect(document.querySelectorAll('select[aria-label^="턴 요약 "]')).toHaveLength(2);
});

it("설정 조회 실패 때 요약 설정의 오류를 보인다", async () => {
  await mount(mockFetch({ failRead: true }) as typeof fetch);
  expect(document.body.textContent).toContain("요약 설정을 불러오지 못했습니다 (503)");
  expect(button("요약 설정 저장").disabled).toBe(true);
});

it("목록 조회 실패의 까닭을 보인다", async () => {
  await mount(mockFetch({ failCatalog: true }) as typeof fetch);
  expect(document.body.textContent).toContain("모델 목록을 불러오지 못했습니다 (503)");
  expect(button("요약 설정 저장").disabled).toBe(true);
});

it("첫 로딩 중에는 버튼 줄을 그리지 않는다", async () => {
  await mount(vi.fn(() => new Promise<Response>(() => {})) as typeof fetch);
  expect(document.body.textContent).toContain("불러오는 중");
  expect([...document.querySelectorAll("button")].some(item => item.textContent === "다시 불러오기")).toBe(false);
});
