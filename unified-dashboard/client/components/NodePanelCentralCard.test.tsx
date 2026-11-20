/** @vitest-environment jsdom */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeAccount, ClaudeAccountList } from "@seosoyoung/soul-ui";

vi.mock("@seosoyoung/soul-ui", async () => {
  const usage = await import("../../../packages/soul-ui/src/lib/usage-summary");
  return {
    ...usage,
    cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" "),
    Button: ({ children, render: _render, variant: _variant, size: _size, ...props }: Record<string, unknown> & { children?: ReactNode }) =>
      <button type="button" {...props}>{children}</button>,
    DashboardIconCap: ({ children, label, ...props }: Record<string, unknown> & { children?: ReactNode; label: string }) =>
      <button type="button" aria-label={label} {...props}>{children}</button>,
    Switch: ({ checked, onCheckedChange, ...props }: Record<string, unknown> & { checked: boolean; onCheckedChange: (checked: boolean) => void }) =>
      <button type="button" role="switch" aria-checked={checked} onClick={() => onCheckedChange(!checked)} {...props} />,
    Input: (props: Record<string, unknown>) => <input {...props} />,
  };
});

vi.mock("./NodeProvidersPanel", () => ({
  PendingClaudeRow: () => <div data-testid="pending-row" />,
}));

import { CENTRAL_ACCOUNTS_QUERY_KEY, NodePanelCentralCard } from "./NodePanelCentralCard";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const reset = "2030-01-01T00:00:00.000Z";

function account(id: string, priority: number): ClaudeAccount {
  return {
    id,
    email: `${id}@example.test`,
    plan: "Pro",
    enabled: true,
    priority,
    auth_state: "ok",
    usage: {
      five_hour: { used_percent: 10, resets_at: reset },
      seven_day: { used_percent: 20, resets_at: reset },
      fable_weekly: { used_percent: 30, resets_at: reset },
    },
    observed_at: null,
    blocked: null,
    active_sessions: 0,
  };
}

function list(accounts: ClaudeAccount[]): ClaudeAccountList {
  return {
    mode: "pool",
    accounts,
    pool: {
      available_count: accounts.length,
      total_count: accounts.length,
      best_weekly_remaining_percent: 80,
      best_weekly_resets_at: reset,
      earliest_available_at: null,
    },
    fable_pool: null,
  };
}

function data(value: unknown): Response {
  return Response.json(value);
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
      <NodePanelCentralCard request={request} />
    </QueryClientProvider>,
  ));
  await settle();
}

const card = () => host.querySelector<HTMLElement>('[data-testid="claude-central-pool-card"]')!;
const head = () => host.querySelector<HTMLElement>('[data-testid="claude-central-pool-header"]')!;

async function expand() {
  await act(async () => head().dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await settle();
}

function accountIds(): string[] {
  return Array.from(host.querySelectorAll<HTMLElement>("[data-account-id]"), (row) => row.dataset.accountId ?? "");
}

describe("NodePanelCentralCard", () => {
  it("draws only the title while collapsed and does not read the central list", async () => {
    const request = vi.fn<typeof fetch>(async () => data(list([account("a", 1)])));
    await mount(request as unknown as typeof fetch);

    expect(card().textContent).toContain("중앙 풀");
    expect(head().getAttribute("aria-expanded")).toBe("false");
    expect(request).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="claude-pool-row-header"]')).toBeNull();
  });

  it("reads the central list when opened and draws the same pool row as a node card", async () => {
    const initial = list([account("a", 1), account("b", 2)]);
    const request = vi.fn<typeof fetch>(async () => data(initial));
    await mount(request as unknown as typeof fetch);

    await expand();

    expect(request).toHaveBeenCalledWith("/api/claude-auth/central/accounts", expect.objectContaining({ method: "GET" }));
    expect(client.getQueryData(CENTRAL_ACCOUNTS_QUERY_KEY)).toEqual(initial);
    expect(host.querySelector('[data-testid="claude-pool-row-header"]')?.textContent).toContain("2/2 가용");

    await act(async () => host.querySelector<HTMLElement>('[data-testid="claude-pool-row-header"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();
    expect(accountIds()).toEqual(["a", "b"]);
  });

  it("shows the shared pending row in place until the central list arrives", async () => {
    const request = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
    await mount(request as unknown as typeof fetch);

    await expand();

    expect(host.querySelector('[data-testid="pending-row"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="claude-pool-row-header"]')).toBeNull();
  });

  it("shows the list failure in place and reads again through its retry button", async () => {
    const initial = list([account("a", 1)]);
    let fails = true;
    const request = vi.fn<typeof fetch>(async () => {
      if (fails) throw new Error("중앙 풀을 읽지 못했습니다");
      return data(initial);
    });
    await mount(request as unknown as typeof fetch);

    await expand();
    expect(host.querySelector('[data-testid="claude-central-list-error"] [role="alert"]')?.textContent)
      .toBe("중앙 풀을 읽지 못했습니다");

    fails = false;
    const retry = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((item) => item.textContent?.trim() === "다시 시도")!;
    await act(async () => retry.click());
    await settle();

    expect(request).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[data-testid="claude-central-list-error"]')).toBeNull();
    expect(host.querySelector('[data-testid="claude-pool-row-header"]')?.textContent).toContain("1/1 가용");
  });
});
