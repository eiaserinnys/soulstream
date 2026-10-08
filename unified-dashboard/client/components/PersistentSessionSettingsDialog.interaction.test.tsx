/** @vitest-environment jsdom */

import { act, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDashboardStore } from "@seosoyoung/soul-ui";

import { PersistentSessionSettingsDialog } from "./PersistentSessionSettingsDialog";
import type { PersistentSession } from "../lib/persistent-sessions";
import { createPersistentSessionsApi } from "../lib/persistent-sessions";
import { PersistentSessionDetails, usePersistentSessionDetailsController } from "./PersistentSessionDetails";
import { persistentSessionQuotaRows } from "./PersistentSessionMonitoring";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  useDashboardStore.getState().setActiveSession("sample-pas");
  useDashboardStore.getState().setPersistentSessionDisplaySettings("sample-pas", makeSession().settings);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

it("saves one display field immediately and publishes only the returned settings", async () => {
  const resource = makeSession();
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  let release!: () => void;
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input), "https://sample.invalid");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ path: url.pathname, method, body });
    if (url.pathname === "/api/persistent-sessions/sample-pas" && method === "GET") return Response.json({ session: resource });
    if (url.pathname === "/api/persistent-sessions/sample-pas/instructions") return Response.json({ instructions: [] });
    if (url.pathname === "/api/sessions/sample-pas/timeline") return Response.json({ messages: [], next_cursor: null });
    if (method === "PUT") return await new Promise<Response>((resolve) => {
      release = () => {
        resource.settings.show_character = false;
        resolve(Response.json({ session: resource, model_change: "none" }));
      };
    });
    throw new Error(`Unexpected request: ${method} ${url.pathname}`);
  };

  await act(async () => root.render(<PersistentSessionSettingsDialog sessionId="sample-pas" nodeId="sample-node" request={request} onClose={vi.fn()} modelPresetCatalog={modelPresetCatalog} />));
  await settle();
  expect(calls.some((call) => call.path === "/api/persistent-sessions/sample-pas/instructions" && call.method === "GET")).toBe(true);
  click("지속 지시");
  click("표시와 모션");
  expect([...document.body.querySelectorAll<HTMLButtonElement>("[role=switch]")].map((control) => control.getAttribute("aria-label"))).toEqual([
    "캐릭터 표시", "캐릭터 움직임", "세대 구분선 표시", "Jev 후보 표시",
  ]);
  const switchControl = switchFor("캐릭터 표시");
  expect(switchControl?.getAttribute("aria-checked")).toBe("true");
  expect(switchControl?.getAttribute("aria-label")).toBe("캐릭터 표시");

  switchControl?.focus();
  await act(async () => switchControl?.click());
  expect(calls.filter((call) => call.method === "PUT")).toEqual([{
    path: "/api/persistent-sessions/sample-pas",
    method: "PUT",
    body: { settings: { show_character: false } },
  }]);
  expect(switchControl?.getAttribute("aria-checked")).toBe("true");
  expect(switchControl?.disabled).toBe(false);
  expect(switchControl?.getAttribute("aria-disabled")).toBe("true");
  expect(document.activeElement).toBe(switchControl);
  expect(document.body.querySelectorAll('[role="status"]')).toHaveLength(1);
  expect([...document.body.querySelectorAll('[role="switch"]')].every((control) => control.classList.contains("opacity-50"))).toBe(true);
  expect(document.body.querySelector('[role="status"]')?.closest('[data-testid="config-field-row"]')?.textContent).toContain("캐릭터 표시");

  await act(async () => release());
  await settle();
  expect(switchFor("캐릭터 표시")?.getAttribute("aria-checked")).toBe("false");
  expect(useDashboardStore.getState().persistentSessionDisplaySettings?.showCharacter).toBe(false);
});

it("keeps the persisted switch value when an immediate update fails", async () => {
  const resource = makeSession();
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input), "https://sample.invalid");
    if (url.pathname === "/api/persistent-sessions/sample-pas" && (init?.method ?? "GET") === "GET") return Response.json({ session: resource });
    if (url.pathname === "/api/persistent-sessions/sample-pas/instructions") return Response.json({ instructions: [] });
    if (url.pathname === "/api/sessions/sample-pas/timeline") return Response.json({ messages: [], next_cursor: null });
    if ((init?.method ?? "GET") === "PUT") return Response.json({ error: { message: "예시 저장 실패" } }, { status: 503 });
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url.pathname}`);
  };

  await act(async () => root.render(<PersistentSessionSettingsDialog sessionId="sample-pas" nodeId="sample-node" request={request} onClose={vi.fn()} modelPresetCatalog={modelPresetCatalog} />));
  await settle();
  click("표시와 모션");
  await act(async () => switchFor("캐릭터 표시")?.click());
  await settle();

  expect(switchFor("캐릭터 표시")?.getAttribute("aria-checked")).toBe("true");
  expect(document.body.textContent).toContain("저장하지 못했습니다. 다시 눌러 주세요.");
  expect(useDashboardStore.getState().persistentSessionDisplaySettings?.showCharacter).toBe(true);
  click("계정과 모델");
  expect(document.body.textContent).not.toContain("저장하지 못했습니다. 다시 눌러 주세요.");
  click("표시와 모션");
  expect(document.body.textContent).toContain("저장하지 못했습니다. 다시 눌러 주세요.");
});

it.each([
  ["캐릭터 표시", "show_character", "showCharacter"],
  ["캐릭터 움직임", "animate_character", "animateCharacter"],
  ["세대 구분선 표시", "show_generation_separator", "showGenerationSeparator"],
  ["Jev 후보 표시", "show_jev_candidates", "showJevCandidates"],
] as const)("preserves drafts and the immediately saved %s through account save", async (label, key, storeKey) => {
  let resource = makeSession();
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input), "https://sample.invalid");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ path: url.pathname, method, body });
    if (method === "PUT") {
      resource = { ...resource, display_name: body.display_name ?? resource.display_name, settings: { ...resource.settings, ...body.settings } };
      return Response.json({ session: resource, model_change: "none" });
    }
    if (url.pathname === "/api/persistent-sessions/sample-pas/instructions") return Response.json({ instructions: [] });
    throw new Error(`Unexpected request: ${method} ${url.pathname}`);
  };

  await act(async () => root.render(<DraftPreservationHarness resource={resource} request={request} />));
  await settle();
  const nameInput = [...document.body.querySelectorAll<HTMLInputElement>("input")].find((input) => input.closest("[data-testid=config-field-row]")?.textContent?.includes("세션 이름"));
  expect(nameInput).toBeDefined();
  expect(nameInput?.getAttribute("aria-label")).toBe("세션 이름");
  expect(document.body.querySelector('[aria-label="기본 모델"]')).not.toBeNull();
  expect(document.body.querySelector('[aria-label="모델 선택"]')).toBeNull();
  await setInput(nameInput!, "보존할 이름 초안");
  click("모델 초안 선택");
  click("표시와 모션");
  await act(async () => switchFor(label)?.click());
  await settle();
  expect(calls.filter((call) => call.method === "PUT").map((call) => call.body)).toEqual([{ settings: { [key]: false } }]);

  click("계정과 모델");
  await settle();
  const persistedNameInput = [...document.body.querySelectorAll<HTMLInputElement>("input")].find((input) => input.closest("[data-testid=config-field-row]")?.textContent?.includes("세션 이름"));
  expect(persistedNameInput?.value).toBe("보존할 이름 초안");
  expect(document.body.querySelector('[aria-label="기본 모델"]')?.textContent).toContain("Sol");
  click("변경 저장");
  await settle();
  expect(calls.filter((call) => call.method === "PUT").map((call) => call.body)).toEqual([
    { settings: { [key]: false } },
    { display_name: "보존할 이름 초안", settings: { default_model: { model_preset: "sample-sol", reasoning_effort: null } } },
  ]);
  expect(resource.settings[key]).toBe(false);
  expect(useDashboardStore.getState().persistentSessionDisplaySettings?.[storeKey]).toBe(false);
  click("표시와 모션");
  expect(switchFor(label)?.getAttribute("aria-checked")).toBe("false");
});

it("shows server-calculated weekly headroom for session providers and omits remaining percent", async () => {
  const resource = makeSession();
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input), "https://sample.invalid");
    if (url.pathname === "/api/persistent-sessions/sample-pas" && (init?.method ?? "GET") === "GET") return Response.json({ session: resource });
    if (url.pathname === "/api/persistent-sessions/sample-pas/instructions") return Response.json({ instructions: [] });
    if (url.pathname === "/api/sessions/sample-pas/timeline") return Response.json({ messages: [], next_cursor: null });
    if (url.pathname === "/api/nodes/sample-node/model-presets") return Response.json({ model_presets: [
      { id: "sample-opus", label: "Opus", backend: "claude", available: true, reason: null, reason_label: null, resets_at: "2026-10-08T00:00:00.000Z", usage_warning: false,
        weekly_headroom: { status: "ok", headroom: 12.5, remaining_percent: 72.5, window_remaining_percent: 60, resets_at: "2026-10-08T00:00:00.000Z", observed_at: "2026-10-06T02:00:00.000Z", quota_label: "7일" } },
      { id: "sample-sol", label: "Sol", backend: "codex", available: true, reason: null, reason_label: null, resets_at: null, usage_warning: false,
        weekly_headroom: { status: "ok", headroom: -56.6, remaining_percent: 21, window_remaining_percent: 77.6, resets_at: null, observed_at: "2026-10-06T02:01:00.000Z", quota_label: "7일" } },
    ] });
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url.pathname}`);
  };

  await act(async () => root.render(<PersistentSessionSettingsDialog sessionId="sample-pas" nodeId="sample-node" request={request} onClose={vi.fn()} modelPresetCatalog={modelPresetCatalog} />));
  await settle();

  expect(document.body.textContent).toContain("12.5%");
  expect(document.body.textContent).toContain("-56.6%");
  expect(document.body.textContent).not.toContain("72.5%");
  expect(document.body.textContent).not.toContain("77.6%");
});

it("omits weekly headroom when the server has no usable value", () => {
  const resource = makeSession();
  const rows = persistentSessionQuotaRows(resource, [
    { id: "sample-opus", label: "Opus", backend: "claude", available: true, reason: null, reason_label: null, resets_at: null, usage_warning: false, weekly_headroom: null },
    { id: "sample-sol", label: "Sol", backend: "codex", available: true, reason: null, reason_label: null, resets_at: null, usage_warning: false,
      weekly_headroom: { status: "unavailable", headroom: null, remaining_percent: 0, window_remaining_percent: 0, resets_at: null, observed_at: null, quota_label: "7일" } },
  ]);
  expect(rows).toEqual([]);
});

it("uses the shared account detail draft and save action", async () => {
  const resource = makeSession();
  const calls: Array<{ method: string; body: unknown }> = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input), "https://sample.invalid");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (url.pathname === "/api/persistent-sessions/sample-pas" && method === "GET") return Response.json({ session: resource });
    if (url.pathname === "/api/persistent-sessions/sample-pas/instructions") return Response.json({ instructions: [] });
    if (url.pathname === "/api/sessions/sample-pas/timeline") return Response.json({ messages: [], next_cursor: null });
    if (method === "PUT") {
      calls.push({ method, body });
      resource.display_name = body.display_name;
      return Response.json({ session: resource, model_change: "none" });
    }
    throw new Error(`Unexpected request: ${method} ${url.pathname}`);
  };

  await act(async () => root.render(<PersistentSessionSettingsDialog sessionId="sample-pas" nodeId="sample-node" request={request} onClose={vi.fn()} modelPresetCatalog={modelPresetCatalog} />));
  await settle();
  const nameInput = [...document.body.querySelectorAll<HTMLInputElement>("input")].find((input) => input.closest("[data-testid=config-field-row]")?.textContent?.includes("세션 이름"));
  expect(nameInput).toBeDefined();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(nameInput, "수정한 검수 세션");
    nameInput!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const save = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "변경 저장");
  await act(async () => save?.click());
  await settle();

  expect(calls).toEqual([{
    method: "PUT",
    body: { display_name: "수정한 검수 세션", settings: { default_model: { model_preset: "sample-opus", reasoning_effort: null } } },
  }]);
  expect(document.body.textContent).toContain("수정한 검수 세션");
});

it("keeps the settings dialog open when Escape cancels instruction editing and closes it otherwise", async () => {
  const resource = makeSession();
  const onClose = vi.fn();
  const instruction = {
    id: "instruction-1",
    text: "간결하게 답합니다.",
    source_turns: ["T195"],
    created_at: "2026-10-06T10:00:00.000Z",
    updated_at: "2026-10-06T11:00:00.000Z",
    origin: "user",
  };
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input), "https://sample.invalid");
    if (url.pathname === "/api/persistent-sessions/sample-pas" && (init?.method ?? "GET") === "GET") {
      return Response.json({ session: resource });
    }
    if (url.pathname === "/api/persistent-sessions/sample-pas/instructions") return Response.json({ instructions: [instruction] });
    if (url.pathname === "/api/sessions/sample-pas/timeline") return Response.json({ messages: [], next_cursor: null });
    if (url.pathname === "/api/nodes/sample-node/model-presets") return Response.json({ model_presets: [] });
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url.pathname}`);
  };

  await act(async () => root.render(<DismissiblePersistentSessionSettingsDialog request={request} onClose={onClose} />));
  await settle();
  click("지속 지시");
  click("수정");

  const editInput = document.querySelector<HTMLInputElement>('input[aria-label="지속 지시 수정"]')!;
  await act(async () => editInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));

  expect(document.querySelector('[data-testid="persistent-session-settings-dialog"]')).not.toBeNull();
  expect(document.querySelector('input[aria-label="지속 지시 수정"]')).toBeNull();
  expect(document.body.textContent).toContain("간결하게 답합니다.");
  expect(onClose).not.toHaveBeenCalled();

  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  await settle();
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[data-testid="persistent-session-settings-dialog"]')).toBeNull();
});

it("opens in the instructions section and preserves its draft while sections change", async () => {
  const resource = makeSession();
  const instruction = {
    id: "instruction-1",
    text: "간결하게 답합니다.",
    source_turns: ["T195"],
    created_at: "2026-10-06T10:00:00.000Z",
    updated_at: "2026-10-06T11:00:00.000Z",
    origin: "user",
  };
  let storyRequests = 0;
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input), "https://sample.invalid");
    if (url.pathname === "/api/persistent-sessions/sample-pas" && (init?.method ?? "GET") === "GET") return Response.json({ session: resource });
    if (url.pathname === "/api/persistent-sessions/sample-pas/instructions") return Response.json({ instructions: [instruction] });
    if (url.pathname === "/api/sessions/sample-pas/timeline") return Response.json({ messages: [], next_cursor: null });
    if (url.pathname === "/api/sessions/sample-pas/story") {
      storyRequests += 1;
      return Response.json({ highlight: null, narrative: "부분 줄거리", unfolded_turn_summaries: [], narrative_through_event_id: null, fold_count: 0, updated_at: null });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url.pathname}`);
  };

  await act(async () => root.render(<PersistentSessionSettingsDialog sessionId="sample-pas" nodeId="sample-node" request={request} onClose={vi.fn()} modelPresetCatalog={modelPresetCatalog} />));
  await settle();

  expect([...document.body.querySelectorAll<HTMLButtonElement>("[data-testid=config-category-nav] button")].map((button) => button.textContent?.trim())).toEqual([
    "지속 지시", "계정과 모델", "표시와 모션", "기록", "세션 스토리",
  ]);
  expect(document.querySelector('[aria-label="지속 지시"]')).not.toBeNull();
  expect(document.body.textContent).toContain("이 세션에 계속 적용됩니다.");
  expect(document.body.textContent).toContain("T195");
  expect(document.body.textContent).not.toContain("2026.");
  expect(document.querySelector('[aria-label="새 지속 지시"]')).toBeNull();

  click("지시 추가");
  const addInput = document.querySelector<HTMLInputElement>('[aria-label="새 지속 지시"]')!;
  await setInput(addInput, "섹션을 바꿔도 남는 초안");
  click("계정과 모델");
  click("지속 지시");
  expect(document.querySelector<HTMLInputElement>('[aria-label="새 지속 지시"]')?.value).toBe("섹션을 바꿔도 남는 초안");
  click("세션 스토리");
  await settle();
  expect(storyRequests).toBe(1);
  expect(document.body.textContent).toContain("부분 줄거리");
  click("지속 지시");
  expect(document.querySelector<HTMLInputElement>('[aria-label="새 지속 지시"]')?.value).toBe("섹션을 바꿔도 남는 초안");
});

it("cancels an instruction draft without a request and closes a failed submission with its text retained", async () => {
  const resource = makeSession();
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input), "https://sample.invalid");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ method, path: url.pathname, body });
    if (url.pathname === "/api/persistent-sessions/sample-pas" && method === "GET") return Response.json({ session: resource });
    if (url.pathname === "/api/persistent-sessions/sample-pas/instructions" && method === "GET") return Response.json({ instructions: [] });
    if (url.pathname === "/api/sessions/sample-pas/timeline") return Response.json({ messages: [], next_cursor: null });
    if (url.pathname === "/api/persistent-sessions/sample-pas/instructions" && method === "POST") return Response.json({ error: { message: "예시 저장 실패" } }, { status: 503 });
    throw new Error(`Unexpected request: ${method} ${url.pathname}`);
  };

  await act(async () => root.render(<PersistentSessionSettingsDialog sessionId="sample-pas" nodeId="sample-node" request={request} onClose={vi.fn()} modelPresetCatalog={modelPresetCatalog} />));
  await settle();
  click("지시 추가");
  await setInput(document.querySelector<HTMLInputElement>('[aria-label="새 지속 지시"]')!, "취소할 초안");
  click("취소");
  expect(document.querySelector('[aria-label="새 지속 지시"]')).toBeNull();
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);

  click("지시 추가");
  const addInput = document.querySelector<HTMLInputElement>('[aria-label="새 지속 지시"]')!;
  await setInput(addInput, "실패해도 남을 초안");
  click("추가");
  await settle();
  expect(document.querySelector<HTMLInputElement>('[aria-label="새 지속 지시"]')?.value).toBe("실패해도 남을 초안");
  expect(document.body.textContent).toContain("추가 실패: 예시 저장 실패");
  expect(calls.filter((call) => call.method === "POST").map((call) => call.body)).toEqual([{ text: "실패해도 남을 초안" }]);
});

it("closes the add form only after the instruction is acknowledged", async () => {
  const resource = makeSession();
  let release!: () => void;
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input), "https://sample.invalid");
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/persistent-sessions/sample-pas" && method === "GET") return Response.json({ session: resource });
    if (url.pathname === "/api/persistent-sessions/sample-pas/instructions" && method === "GET") return Response.json({ instructions: [] });
    if (url.pathname === "/api/sessions/sample-pas/timeline") return Response.json({ messages: [], next_cursor: null });
    if (url.pathname === "/api/persistent-sessions/sample-pas/instructions" && method === "POST") return await new Promise<Response>((resolve) => {
      release = () => resolve(Response.json({ instruction: {
        id: "instruction-created",
        text: "저장 확인 뒤 닫힐 지시",
        source_turns: [],
        created_at: "2026-10-08T00:00:00.000Z",
        updated_at: "2026-10-08T00:00:00.000Z",
        origin: "user",
      } }));
    });
    throw new Error(`Unexpected request: ${method} ${url.pathname}`);
  };

  await act(async () => root.render(<PersistentSessionSettingsDialog sessionId="sample-pas" nodeId="sample-node" request={request} onClose={vi.fn()} modelPresetCatalog={modelPresetCatalog} />));
  await settle();
  click("지시 추가");
  await setInput(document.querySelector<HTMLInputElement>('[aria-label="새 지속 지시"]')!, "저장 확인 뒤 닫힐 지시");
  click("추가");
  await settle();
  expect(document.querySelector<HTMLInputElement>('[aria-label="새 지속 지시"]')?.value).toBe("저장 확인 뒤 닫힐 지시");

  await act(async () => release());
  await settle();
  expect(document.querySelector('[aria-label="새 지속 지시"]')).toBeNull();
  expect(document.body.textContent).toContain("저장 확인 뒤 닫힐 지시");
});

it("saves the usage display mode after acknowledgement and keeps the old selection on failure", async () => {
  let resource = makeSession();
  const calls: Array<{ method: string; body: unknown }> = [];
  let release!: () => void;
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input), "https://sample.invalid");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (url.pathname === "/api/persistent-sessions/sample-pas" && method === "GET") return Response.json({ session: resource });
    if (url.pathname === "/api/persistent-sessions/sample-pas/instructions") return Response.json({ instructions: [] });
    if (url.pathname === "/api/sessions/sample-pas/timeline") return Response.json({ messages: [], next_cursor: null });
    if (method === "PUT") {
      calls.push({ method, body });
      return await new Promise<Response>((resolve) => {
        release = () => {
          resource = { ...resource, settings: { ...resource.settings, turn_usage_mode: body.settings.turn_usage_mode, show_turn_usage: body.settings.turn_usage_mode !== "hidden" } };
          resolve(Response.json({ session: resource, model_change: "none" }));
        };
      });
    }
    throw new Error(`Unexpected request: ${method} ${url.pathname}`);
  };

  await act(async () => root.render(<PersistentSessionSettingsDialog sessionId="sample-pas" nodeId="sample-node" request={request} onClose={vi.fn()} modelPresetCatalog={modelPresetCatalog} />));
  await settle();
  click("표시와 모션");
  const row = [...document.body.querySelectorAll<HTMLElement>("[data-testid=config-field-row]")].find((item) => item.textContent?.includes("턴 끝 사용량"))!;
  const buttons = [...row.querySelectorAll<HTMLButtonElement>("button")];
  expect(buttons.map((button) => button.textContent?.trim())).toEqual(["접어서", "펼쳐서", "숨김"]);
  expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);
  act(() => buttons[1]?.click());
  expect(calls).toEqual([{ method: "PUT", body: { settings: { turn_usage_mode: "expanded" } } }]);
  expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);
  await act(async () => release());
  await settle();
  expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual(["false", "true", "false"]);
  expect(useDashboardStore.getState().persistentSessionDisplaySettings?.turnUsageMode).toBe("expanded");
});

it("keeps the target identity accessible and displays the read-only agent value without repeated explanation", async () => {
  const resource = makeSession();
  const request: typeof fetch = async (input) => {
    const url = new URL(String(input), "https://sample.invalid");
    if (url.pathname === "/api/persistent-sessions/sample-pas") return Response.json({ session: resource });
    if (url.pathname === "/api/persistent-sessions/sample-pas/instructions") return Response.json({ instructions: [] });
    if (url.pathname === "/api/sessions/sample-pas/timeline") return Response.json({ messages: [], next_cursor: null });
    if (url.pathname === "/api/nodes/sample-node/model-presets") return Response.json({ model_presets: [] });
    throw new Error(`Unexpected request: ${url.pathname}`);
  };

  await act(async () => root.render(<PersistentSessionSettingsDialog sessionId="sample-pas" nodeId="sample-node" request={request} onClose={vi.fn()} modelPresetCatalog={modelPresetCatalog} />));
  await settle();

  const description = document.querySelector<HTMLElement>('[data-slot="dialog-description"]');
  expect(description?.classList.contains("sr-only")).toBe(true);
  expect(description?.textContent).toContain("검수 세션");
  expect(description?.textContent).toContain("로젤린");
  click("계정과 모델");
  const accountRows = [...document.body.querySelectorAll<HTMLElement>("[data-testid=config-field-row]")];
  const agentRow = accountRows.find((row) => row.textContent?.includes("에이전트"));
  expect(agentRow?.querySelector('[data-testid="config-field-value"]')?.textContent).toBe("로젤린");
  expect(agentRow?.querySelector("input")).toBeNull();
  expect(agentRow?.textContent).not.toContain("만든 뒤에는 바꿀 수 없습니다.");
  expect(document.body.textContent).not.toContain("만든 뒤에는 바꿀 수 없습니다.");
});

it("shows a failed instruction edit beside its retained draft and save controls", async () => {
  const resource = makeSession();
  const instruction = {
    id: "instruction-edit-failure",
    text: "저장에 실패할 지시",
    source_turns: ["T195"],
    created_at: "2026-10-06T10:00:00.000Z",
    updated_at: "2026-10-06T11:00:00.000Z",
    origin: "agent",
  };
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input), "https://sample.invalid");
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/persistent-sessions/sample-pas" && method === "GET") return Response.json({ session: resource });
    if (url.pathname === "/api/persistent-sessions/sample-pas/instructions" && method === "GET") return Response.json({ instructions: [instruction] });
    if (url.pathname === "/api/sessions/sample-pas/timeline") return Response.json({ messages: [], next_cursor: null });
    if (url.pathname === "/api/nodes/sample-node/model-presets") return Response.json({ model_presets: [] });
    if (url.pathname === `/api/persistent-sessions/sample-pas/instructions/${instruction.id}` && method === "PUT") {
      return Response.json({ error: { code: "NODE_UNAVAILABLE", message: "예시 편집 저장 실패" } }, { status: 503 });
    }
    throw new Error(`Unexpected request: ${method} ${url.pathname}`);
  };

  await act(async () => root.render(<PersistentSessionSettingsDialog sessionId="sample-pas" nodeId="sample-node" request={request} onClose={vi.fn()} modelPresetCatalog={modelPresetCatalog} />));
  await settle();
  const row = document.querySelector<HTMLElement>('[data-testid="persistent-instruction-row"]')!;
  click("수정");
  const input = row.querySelector<HTMLInputElement>('[aria-label="지속 지시 수정"]')!;
  await setInput(input, "저장 재시도할 편집 초안");
  click("저장");
  await settle();

  expect(row.querySelector('[role="alert"]')?.textContent).toContain("저장 실패: 예시 편집 저장 실패");
  expect(row.querySelector<HTMLInputElement>('[aria-label="지속 지시 수정"]')?.value).toBe("저장 재시도할 편집 초안");
  expect([...row.querySelectorAll<HTMLButtonElement>("button")].some((button) => button.textContent === "저장")).toBe(true);
  expect(document.body.querySelectorAll('[role="alert"]')).toHaveLength(1);
});

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function setInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function DraftPreservationHarness({ resource: initialResource, request }: { resource: PersistentSession; request: typeof fetch }) {
  const [resource, setResource] = useState(initialResource);
  const [section, setSection] = useState<"account" | "display">("account");
  const api = useMemo(() => createPersistentSessionsApi(request), [request]);
  const details = usePersistentSessionDetailsController({ resource, api, onSaved: (session) => { setResource(session); useDashboardStore.getState().setPersistentSessionDisplaySettings(session.session_id, session.settings); } });
  return <>
    <button type="button" onClick={() => details.onFieldChange("modelPreset", "sample-sol")}>모델 초안 선택</button>
    <button type="button" onClick={() => setSection("account")}>계정과 모델</button>
    <button type="button" onClick={() => setSection("display")}>표시와 모션</button>
    <PersistentSessionDetails
      resource={resource}
      draft={details.draft}
      pending={details.pending}
      savingDisplayField={details.savingDisplayField}
      error={details.error}
      errorScope={details.errorScope}
      section={section}
      immediateDisplaySave
      modelPresetCatalog={modelPresetCatalog}
      onFieldChange={details.onFieldChange}
      onSave={() => { void details.save(); }}
    />
  </>;
}

function DismissiblePersistentSessionSettingsDialog({ request, onClose }: { request: typeof fetch; onClose(): void }) {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return <PersistentSessionSettingsDialog
    sessionId="sample-pas"
    nodeId="sample-node"
    request={request}
    onClose={() => { onClose(); setOpen(false); }}
    modelPresetCatalog={modelPresetCatalog}
  />;
}

function click(label: string) {
  const button = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label);
  if (!button) throw new Error(`Button not found: ${label}`);
  act(() => button.click());
}

function switchFor(label: string) {
  const row = [...document.body.querySelectorAll<HTMLElement>("[data-testid=config-field-row]")]
    .find((element) => element.textContent?.includes(label));
  return row?.querySelector<HTMLButtonElement>("[role=switch]");
}

function makeSession(): PersistentSession {
  return {
  session_id: "sample-pas",
  display_name: "검수 세션",
  node_id: "sample-node",
  folder_id: "sample-folder",
  agent_id: "roselin",
  agent_name: "로젤린",
  persistent: true,
  settings: {
    default_model: { model_preset: "sample-opus", reasoning_effort: null },
    fallback_model: null,
    show_generation_separator: true,
    show_character: true,
    animate_character: true,
    show_jev_candidates: true,
    turn_usage_mode: "collapsed",
    show_turn_usage: true,
  },
  runtime: {
    current_model: { model_preset: "sample-sol", reasoning_effort: "high", model: "sample-sol-model" },
    pending: { target_model_preset: "sample-opus", target_reasoning_effort: null },
  },
  };
}

const modelPresetCatalog = {
  status: "ready" as const,
  nodeId: "sample-node",
  presets: [
    { id: "sample-opus", label: "Opus", backend: "claude", available: true, reason: null, reason_label: null, resets_at: null, usage_warning: false },
    { id: "sample-sol", label: "Sol", backend: "codex", available: true, reason: null, reason_label: null, resets_at: null, usage_warning: false },
  ],
};
