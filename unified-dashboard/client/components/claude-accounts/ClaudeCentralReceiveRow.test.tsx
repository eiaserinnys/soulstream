/** @vitest-environment jsdom */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeAccountList } from "../../../../packages/wire-schema/generated/typescript/index";
import type { ClaudeCentralSettings } from "@seosoyoung/soul-ui";

vi.mock("@seosoyoung/soul-ui", () => ({
  Button: ({ children, render: _render, variant: _variant, size: _size, ...props }: Record<string, unknown> & { children?: ReactNode }) =>
    <button type="button" {...props}>{children}</button>,
  Switch: ({ checked, onCheckedChange, ...props }: Record<string, unknown> & { checked: boolean; onCheckedChange: (checked: boolean) => void }) =>
    <button type="button" role="switch" aria-checked={checked} onClick={() => onCheckedChange(!checked)} {...props} />,
}));

import { ClaudeCentralReceiveRow } from "./ClaudeCentralReceiveRow";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function data(value: unknown): Response {
  return Response.json(value);
}

function settings(receive: boolean, defaultReceive = false): ClaudeCentralSettings {
  return {
    default_receive: defaultReceive,
    nodes: { "node-a": receive },
    effective: [{ node_id: "node-a", receive, connected: true }],
  };
}

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
});

async function settle() {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

async function mount(request: typeof fetch) {
  await act(async () => root.render(
    <QueryClientProvider client={client}>
      <ClaudeCentralReceiveRow nodeId="node-a" request={request} />
    </QueryClientProvider>,
  ));
  await settle();
}

const row = () => host.querySelector<HTMLElement>('[data-testid="claude-central-receive"]')!;
const switchEl = () => host.querySelector<HTMLButtonElement>('[data-testid="claude-central-receive-switch"]')!;

function button(label: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

describe("ClaudeCentralReceiveRow", () => {
  it("draws the node's saved receive value and writes only that node through the central settings PUT", async () => {
    const initial = settings(true);
    const next = settings(false);
    const accountList: ClaudeAccountList = { mode: "pool", accounts: [], pool: null, fable_pool: null };
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === "PUT") return data(next);
      return data(initial);
    });
    client.setQueryData(["claude-auth-accounts", "node-a"], accountList);

    await mount(request as unknown as typeof fetch);
    expect(row().dataset.receive).toBe("on");
    expect(switchEl().getAttribute("aria-checked")).toBe("true");

    await act(async () => switchEl().click());
    await settle();

    expect(request).toHaveBeenCalledWith("/api/claude-auth/central/settings", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ nodes: { "node-a": false } }),
    }));
    expect(row().dataset.receive).toBe("off");
    expect(switchEl().getAttribute("aria-checked")).toBe("false");
    expect(client.getQueryData(["claude-central-settings"])).toEqual(next);
    expect(client.getQueryState(["claude-auth-accounts", "node-a"])?.isInvalidated).toBe(true);
  });

  it("shows the requested value with the switch disabled while the save is pending", async () => {
    const initial = settings(true);
    const next = settings(false);
    let resolvePut!: (response: Response) => void;
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === "PUT") return new Promise<Response>((resolve) => { resolvePut = resolve; });
      return data(initial);
    });
    await mount(request as unknown as typeof fetch);

    await act(async () => switchEl().click());
    await settle();
    expect(row().dataset.receive).toBe("off");
    expect(switchEl().disabled).toBe(true);

    await act(async () => resolvePut(data(next)));
    await settle();
    expect(switchEl().disabled).toBe(false);
    expect(row().dataset.receive).toBe("off");
  });

  it("keeps the switch in place and retries through it after a failed save", async () => {
    const initial = settings(true);
    const saved = settings(false);
    let puts = 0;
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === "PUT") {
        puts += 1;
        if (puts === 1) throw new Error("설정 저장 실패");
        return data(saved);
      }
      return data(initial);
    });
    await mount(request as unknown as typeof fetch);

    await act(async () => switchEl().click());
    await settle();
    expect(row().dataset.receive).toBe("on");
    expect(switchEl().getAttribute("aria-checked")).toBe("true");
    expect(switchEl().disabled).toBe(false);
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.textContent).toBe("설정 저장 실패");
    const line = row().querySelector(".c724-account-top")!;
    // 오류 글은 받기 줄 아래에 서서 줄 높이를 바꾸지 않는다.
    expect(line.contains(alert)).toBe(false);
    expect(line.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(Array.from(host.querySelectorAll("button")).some((item) => item.textContent?.trim() === "다시 시도")).toBe(false);

    // 다시 시도는 스위치를 다시 누르는 것이다.
    await act(async () => switchEl().click());
    await settle();
    expect(puts).toBe(2);
    expect(request).toHaveBeenLastCalledWith("/api/claude-auth/central/settings", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ nodes: { "node-a": false } }),
    }));
    expect(row().dataset.receive).toBe("off");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows the settings load failure in place and reads again through the retry button", async () => {
    let fail = true;
    const request = vi.fn<typeof fetch>(async () => {
      if (fail) throw new Error("설정을 읽지 못했습니다");
      return data(settings(true));
    });
    await mount(request as unknown as typeof fetch);

    // 이름은 남고 스위치 자리만 다시 시도로 바뀐다.
    expect(row().textContent).toContain("중앙 풀 받기");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("설정을 읽지 못했습니다");
    expect(host.querySelector('[data-testid="claude-central-receive-switch"]')).toBeNull();

    fail = false;
    await act(async () => button("다시 시도").click());
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
    expect(switchEl().getAttribute("aria-checked")).toBe("true");
  });
});
