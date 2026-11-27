/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AntigravityBackendRow } from "./AntigravityBackendRow";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Payload = { value: { enabled: boolean }; version: number; source: "default" | "settings" };
const off: Payload = { value: { enabled: false }, version: 0, source: "default" };
const on: Payload = { value: { enabled: true }, version: 3, source: "settings" };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await act(async () => root.unmount());
  host.remove();
  document.body.querySelectorAll("[data-base-ui-inert], [role=dialog]").forEach((node) => node.remove());
});

async function settle() {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

function fakeServer(initial: Payload, put?: (body: Record<string, unknown>) => Response | Promise<Response>) {
  const puts: Array<Record<string, unknown>> = [];
  const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("/api/admin/settings/antigravity-backend");
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      puts.push(body);
      if (put) return put(body);
      const value = body.value as { enabled: boolean };
      return Response.json({ value: { enabled: value.enabled }, version: Number(body.expectedVersion) + 1, source: "settings" });
    }
    return Response.json(initial);
  }) as unknown as typeof fetch;
  return { request, puts };
}

async function mount(request: typeof fetch, onSaved?: () => void) {
  await act(async () => root.render(<AntigravityBackendRow request={request} onSaved={onSaved} />));
  await settle();
}

const toggle = () => host.querySelector<HTMLElement>('[data-testid="antigravity-backend-switch"]')!;
const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
const confirmInput = () => dialog()!.querySelector<HTMLInputElement>("input")!;
const confirmButton = () => [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((button) => /켜기|다시 시도/.test(button.textContent ?? ""))!;
const cancelButton = () => [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "취소")!;
const type = async (text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(confirmInput(), text);
  confirmInput().dispatchEvent(new Event("input", { bubbles: true }));
});
const click = async (element: HTMLElement) => { await act(async () => { element.click(); }); await settle(); };

describe("Antigravity switch row", () => {
  it("opens the confirmation dialog instead of saving when turned on, and enables the confirm button only for the exact phrase", async () => {
    const server = fakeServer(off);
    await mount(server.request);
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    await click(toggle());
    expect(dialog()).not.toBeNull();
    expect(server.puts).toEqual([]);
    expect(confirmButton().disabled).toBe(true);
    await type("인지");
    expect(confirmButton().disabled).toBe(true);
    await type("인지했습니다");
    expect(confirmButton().disabled).toBe(false);
  });

  it("sends the acknowledgement with the current version after the phrase is typed, then closes and shows the switch on", async () => {
    const server = fakeServer(off);
    await mount(server.request);
    await click(toggle());
    await type("  인지했습니다 ");
    await click(confirmButton());
    expect(server.puts).toEqual([{ value: { enabled: true, acknowledgement: "인지했습니다" }, expectedVersion: 0 }]);
    expect(dialog()).toBeNull();
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });

  it("leaves the switch off when the dialog is cancelled", async () => {
    const server = fakeServer(off);
    await mount(server.request);
    await click(toggle());
    await click(cancelButton());
    expect(dialog()).toBeNull();
    expect(server.puts).toEqual([]);
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });

  it("turns off at once without a dialog", async () => {
    const server = fakeServer(on);
    await mount(server.request);
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    await click(toggle());
    expect(dialog()).toBeNull();
    expect(server.puts).toEqual([{ value: { enabled: false }, expectedVersion: 3 }]);
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });

  it("shows a save failure inside the dialog and keeps it open for another try", async () => {
    let fail = true;
    const server = fakeServer(off, (body) => fail
      ? Response.json({ detail: { error: { code: "X", message: "boom" } } }, { status: 500 })
      : Response.json({ value: { enabled: true }, version: Number(body.expectedVersion) + 1, source: "settings" }));
    await mount(server.request);
    await click(toggle());
    await type("인지했습니다");
    await click(confirmButton());
    expect(dialog()!.querySelector('[role="alert"]')).not.toBeNull();
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    fail = false;
    await click(confirmButton());
    expect(dialog()).toBeNull();
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });

  it("replaces the switch with a failure notice and a retry when the setting cannot be read", async () => {
    let calls = 0;
    const request = vi.fn(async () => (calls++ === 0 ? new Response("down", { status: 503 }) : Response.json(off))) as unknown as typeof fetch;
    await mount(request);
    expect(toggle()).toBeNull();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    const retry = [...host.querySelectorAll("button")].find((button) => button.textContent === "다시 시도")!;
    await click(retry);
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });

  it("tells its parent after each successful save, and not after a failed one", async () => {
    let fail = true;
    const server = fakeServer(off, (body) => fail
      ? Response.json({ detail: { error: { code: "X", message: "boom" } } }, { status: 500 })
      : Response.json({ value: { enabled: true }, version: Number(body.expectedVersion) + 1, source: "settings" }));
    const onSaved = vi.fn();
    await mount(server.request, onSaved);
    await click(toggle());
    await type("인지했습니다");
    await click(confirmButton());
    expect(onSaved).not.toHaveBeenCalled();
    fail = false;
    await click(confirmButton());
    expect(onSaved).toHaveBeenCalledTimes(1);
    await click(toggle());
    expect(onSaved).toHaveBeenCalledTimes(2);
  });
});
