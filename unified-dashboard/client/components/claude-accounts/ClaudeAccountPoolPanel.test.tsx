/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeAccount, ClaudeAccountList, ClaudeAuthLoginFlow } from "@seosoyoung/soul-ui";
import { ClaudeAccountPoolPanel } from "./ClaudeAccountPoolPanel";

vi.mock("@seosoyoung/soul-ui", async () => {
  const React = await import("react");
  return {
    Button: ({ children, render, variant: _variant, size: _size, ...props }: Record<string, unknown> & { children?: unknown; render?: React.ReactElement }) => {
      if (render) return React.cloneElement(render, { ...props, children } as never);
      return React.createElement("button", { type: "button", ...props }, children as never);
    },
    DashboardIconCap: ({ children, label, ...props }: Record<string, unknown> & { children?: unknown; label: string }) =>
      React.createElement("button", { type: "button", "aria-label": label, ...props }, children as never),
    Input: (props: Record<string, unknown>) => React.createElement("input", props),
    Switch: ({ checked, onCheckedChange, ...props }: Record<string, unknown> & { checked: boolean; onCheckedChange: (checked: boolean) => void }) =>
      React.createElement("button", {
        type: "button",
        role: "switch",
        "aria-checked": checked,
        onClick: () => onCheckedChange(!checked),
        ...props,
      }),
  };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const reset = "2030-01-01T00:00:00.000Z";
function account(id: string, priority: number, email = `${id}@example.test`): ClaudeAccount {
  return {
    id,
    email,
    plan: "Pro",
    enabled: true,
    priority,
    auth_state: "ok",
    usage: {
      five_hour: { used_percent: priority * 10, resets_at: reset },
      seven_day: { used_percent: priority * 12, resets_at: reset },
      fable_weekly: { used_percent: priority * 8, resets_at: reset },
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
      best_weekly_remaining_percent: 88,
      best_weekly_resets_at: reset,
      earliest_available_at: null,
    },
    fable_pool: null,
  };
}

function data(value: unknown): Response {
  return Response.json(value);
}

function flow(state: ClaudeAuthLoginFlow["state"], overrides: Partial<ClaudeAuthLoginFlow> = {}): ClaudeAuthLoginFlow {
  return {
    login_id: "login-a",
    account_id: null,
    state,
    auth_url: state === "url_ready" ? "https://example.invalid/auth" : null,
    expires_at: "2030-01-01T00:00:00.000Z",
    error: null,
    ...overrides,
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
  vi.useRealTimers();
});

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(initial: ClaudeAccountList, request: typeof fetch) {
  await act(async () => root.render(<QueryClientProvider client={client}>
    <ClaudeAccountPoolPanel nodeId="node-a" request={request} initialList={initial} />
  </QueryClientProvider>));
  await settle();
}

function accountIds(): string[] {
  return Array.from(host.querySelectorAll<HTMLElement>("[data-account-id]"), (row) => row.dataset.accountId ?? "");
}

function button(label: string, within: ParentNode = host): HTMLButtonElement {
  const found = Array.from(within.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.getAttribute("aria-label") === label || item.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

describe("ClaudeAccountPoolPanel", () => {
  it("renders ranked rows with three horizontal quota cells and disabled boundary arrows", async () => {
    const second = account("second", 2);
    const initial = list([account("first", 1), {
      ...second,
      usage: { ...second.usage, five_hour: { used_percent: 100, resets_at: reset } },
    }]);
    await mount(initial, vi.fn(async () => data(initial)) as unknown as typeof fetch);

    expect(accountIds()).toEqual(["first", "second"]);
    expect(host.querySelectorAll(".c724-quota-cell")).toHaveLength(6);
    expect(button("우선순위 올리기", host.querySelector('[data-account-id="first"]')!).disabled).toBe(true);
    expect(button("우선순위 내리기", host.querySelector('[data-account-id="second"]')!).disabled).toBe(true);
    const releaseTime = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(reset));
    const fiveHourCell = host.querySelector('[data-account-id="second"] .c724-quota-cell')!;
    expect(fiveHourCell.querySelector(".c724-quota-pct")?.textContent).toBe("100%");
    expect(fiveHourCell.querySelector(".c724-quota-reset")?.textContent).toBe(`${releaseTime} 해제`);
    expect(host.textContent).toContain("2/2 가용");
  });

  it("optimistically moves priority and sends only the target PATCH", async () => {
    const initial = list([account("first", 1), account("second", 2), account("third", 3)]);
    let finish!: (response: Response) => void;
    const requestMock = vi.fn<typeof fetch>().mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve; }));
    await mount(initial, requestMock as unknown as typeof fetch);

    await act(async () => button("우선순위 올리기", host.querySelector('[data-account-id="second"]')!).click());
    expect(accountIds()).toEqual(["second", "first", "third"]);
    expect(requestMock).toHaveBeenCalledWith("/api/nodes/node-a/claude-auth/accounts/second", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ priority: 1 }),
    }));

    const returned = list([account("second", 1), account("first", 2), account("third", 3)]);
    await act(async () => finish(data(returned)));
    await settle();
    expect(accountIds()).toEqual(["second", "first", "third"]);
  });

  it("updates enabled state and confirms deletion inline, showing deferred removal", async () => {
    const initial = list([account("first", 1), account("second", 2)]);
    const requestMock = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === "PATCH") return data(list([account("first", 1), { ...account("second", 2), enabled: false }]));
      if (init?.method === "DELETE") return data({ deferred: true, accounts: initial.accounts, pool: { ...initial.pool!, total_count: 1 } });
      return data(initial);
    });
    await mount(initial, requestMock as unknown as typeof fetch);

    const second = host.querySelector('[data-account-id="second"]')!;
    await act(async () => button("second@example.test 사용", second).click());
    await settle();
    expect(requestMock).toHaveBeenCalledWith("/api/nodes/node-a/claude-auth/accounts/second", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    }));
    expect(second.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");

    await act(async () => button("계정 삭제", second).click());
    expect(host.querySelector('[data-testid="delete-confirm-second"]')).not.toBeNull();
    await act(async () => button("삭제", host.querySelector('[data-testid="delete-confirm-second"]')!).click());
    await settle();
    expect(host.textContent).toContain("삭제 예약됨 · 활성 세션 종료 후 제거");
    expect(accountIds()).toEqual(["first", "second"]);
  });

  it("polls login states, prevents duplicate code submission, and refreshes the account list on done", async () => {
    vi.useFakeTimers();
    const initial = list([account("first", 1)]);
    const added = account("new-account", 2, "new@example.test");
    const requestMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(data(flow("requested")))
      .mockResolvedValueOnce(data(flow("url_ready")))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveCode = resolve; }))
      .mockResolvedValueOnce(data(flow("verifying")))
      .mockResolvedValueOnce(data(flow("done")))
      .mockResolvedValueOnce(data(list([account("first", 1), added])));
    let resolveCode!: (response: Response) => void;
    await mount(initial, requestMock as unknown as typeof fetch);

    await act(async () => button("계정 추가").click());
    await settle();
    expect(host.querySelector('[data-testid="claude-login-sheet"]')?.getAttribute("data-login-state")).toBe("requested");
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(host.querySelector('[data-testid="claude-login-sheet"]')?.getAttribute("data-login-state")).toBe("url_ready");

    const code = host.querySelector<HTMLInputElement>('input[aria-label="Claude 인증 코드"]')!;
    expect(host.textContent).toContain("두 번째 계정부터는 시크릿 창이나 별도 브라우저 프로필에서 승인하세요.");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(code, "synthetic-code#synthetic-state");
      code.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const confirm = button("확인");
    await act(async () => { confirm.click(); confirm.click(); });
    expect(requestMock).toHaveBeenCalledTimes(3);
    expect(String(requestMock.mock.calls[2]?.[0])).toBe("/api/nodes/node-a/claude-auth/logins/login-a/code");
    expect(JSON.parse(String(requestMock.mock.calls[2]?.[1]?.body))).toEqual({ code: "synthetic-code#synthetic-state" });

    await act(async () => resolveCode(data(flow("code_submitted"))));
    await settle();
    expect(code.value).toBe("");
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(host.querySelector('[data-testid="claude-login-sheet"]')?.getAttribute("data-login-state")).toBe("verifying");
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await settle();
    expect(host.querySelector('[data-testid="claude-login-sheet"]')?.getAttribute("data-login-state")).toBe("done");
    expect(accountIds()).toEqual(["first", "new-account"]);
  });

  it("retries login status polling after a transient request error", async () => {
    vi.useFakeTimers();
    const initial = list([account("first", 1)]);
    const requestMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(data(flow("requested")))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(data(flow("url_ready")));
    await mount(initial, requestMock as unknown as typeof fetch);

    await act(async () => button("계정 추가").click());
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("offline");

    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(host.querySelector('[data-testid="claude-login-sheet"]')?.getAttribute("data-login-state")).toBe("url_ready");
    expect(requestMock).toHaveBeenCalledTimes(3);
  });

  it("shows human-readable duplicate-account errors and highlights the existing row", async () => {
    const initial = list([account("first", 1), account("existing", 2)]);
    const requestMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(data(flow("url_ready")))
      .mockResolvedValueOnce(Response.json({ code: "account_exists", message: "duplicate", existing_account_id: "existing" }, { status: 409 }));
    await mount(initial, requestMock as unknown as typeof fetch);

    await act(async () => button("계정 추가").click());
    await settle();
    const code = host.querySelector<HTMLInputElement>('input[aria-label="Claude 인증 코드"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(code, "synthetic-code#synthetic-state");
      code.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("확인").click());
    await settle();

    expect(host.textContent).toContain("이미 등록된 계정입니다.");
    expect(host.querySelector('[data-account-id="existing"]')?.getAttribute("data-highlighted")).toBe("true");
  });

  it("shows failed identity mismatch as a readable message and highlights its existing account", async () => {
    const initial = list([account("first", 1), account("existing", 2)]);
    const requestMock = vi.fn<typeof fetch>().mockResolvedValueOnce(data(flow("failed", {
      error: { code: "account_identity_mismatch", message: "identity mismatch", existing_account_id: "existing" },
    })));
    await mount(initial, requestMock as unknown as typeof fetch);

    await act(async () => button("재로그인", host.querySelector('[data-account-id="first"]')!).click());
    await settle();

    expect(host.querySelector('[data-testid="claude-login-sheet"]')?.getAttribute("data-login-state")).toBe("failed");
    expect(host.textContent).toContain("인증한 계정이 기존 계정과 다릅니다. 기존 계정을 유지했습니다.");
    expect(host.querySelector('[data-account-id="existing"]')?.getAttribute("data-highlighted")).toBe("true");
  });

  it("cancels an active login through the login DELETE route", async () => {
    const initial = list([account("first", 1)]);
    const requestMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(data(flow("url_ready")))
      .mockResolvedValueOnce(data(flow("cancelled")));
    await mount(initial, requestMock as unknown as typeof fetch);

    await act(async () => button("계정 추가").click());
    await settle();
    await act(async () => button("로그인 닫기").click());
    await settle();

    expect(requestMock).toHaveBeenLastCalledWith("/api/nodes/node-a/claude-auth/logins/login-a", expect.objectContaining({ method: "DELETE" }));
    expect(host.querySelector('[data-testid="claude-login-sheet"]')).toBeNull();
  });
});
