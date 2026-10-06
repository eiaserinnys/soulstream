/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDashboardStore } from "@seosoyoung/soul-ui";

import { PersistentSessionSettingsDialog } from "./PersistentSessionSettingsDialog";
import type { PersistentSession } from "../lib/persistent-sessions";

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
  click("표시와 모션");
  const switchControl = switchFor("캐릭터 표시");
  expect(switchControl?.getAttribute("aria-checked")).toBe("true");

  await act(async () => switchControl?.click());
  expect(calls.filter((call) => call.method === "PUT")).toEqual([{
    path: "/api/persistent-sessions/sample-pas",
    method: "PUT",
    body: { settings: { show_character: false } },
  }]);
  expect(switchControl?.getAttribute("aria-checked")).toBe("true");
  expect(switchFor("캐릭터 표시")?.disabled).toBe(true);

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
  expect(document.body.textContent).toContain("예시 저장 실패");
  expect(useDashboardStore.getState().persistentSessionDisplaySettings?.showCharacter).toBe(true);
});

it("uses the shared account detail draft and save action", async () => {
  const resource = makeSession();
  const calls: Array<{ method: string; body: unknown }> = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input), "https://sample.invalid");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (url.pathname === "/api/persistent-sessions/sample-pas" && method === "GET") return Response.json({ session: resource });
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

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
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
