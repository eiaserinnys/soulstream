/** @vitest-environment jsdom */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  UsageSummaryNode,
  UsageSummaryProvider,
  UsageSummaryQuota,
} from "@seosoyoung/soul-ui";

const flowMock = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

vi.mock("@seosoyoung/soul-ui", async () => {
  const usage = await import("../../../packages/soul-ui/src/lib/usage-summary");
  return {
    ...usage,
    Button: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
      <button type="button" {...props}>{children}</button>
    ),
    DashboardIconCap: ({ label, ...props }: { label?: string } & Record<string, unknown>) => (
      <button type="button" aria-label={label} {...props} />
    ),
    Switch: ({ checked, onCheckedChange, ...props }: { checked?: boolean; onCheckedChange?: (value: boolean) => void } & Record<string, unknown>) => (
      <button type="button" role="switch" aria-checked={checked} onClick={() => onCheckedChange?.(!checked)} {...props} />
    ),
  };
});

vi.mock("../hooks/useClaudeAuthFlow", () => ({
  useClaudeAuthFlow: () => flowMock.current,
}));

import { NodeProvidersPanel } from "./NodeProvidersPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Math.floor(Date.parse("2026-11-07T15:50:00+09:00") / 1000);
const RESET_LATER = NOW + 3 * 60 * 60;

function quota(
  overrides: Partial<UsageSummaryQuota> & Pick<UsageSummaryQuota, "id" | "label">,
): UsageSummaryQuota {
  return {
    window: null,
    model: null,
    remainingPercent: 50,
    resetAt: RESET_LATER,
    ...overrides,
  };
}

function provider(
  quotas: UsageSummaryQuota[],
  overrides: Partial<UsageSummaryProvider> = {},
): UsageSummaryProvider {
  return {
    status: "auto",
    weeklyRemainingPercent: null,
    weeklyResetAt: null,
    shortRemainingPercent: null,
    shortResetAt: null,
    quotas,
    ...overrides,
  };
}

function summaryNode(providers: Partial<Record<string, UsageSummaryProvider>>): UsageSummaryNode {
  return {
    nodeId: "node-a",
    fetchedAt: "2026-11-07T15:50:00+09:00",
    stale: false,
    staleSince: null,
    providers: {
      claude: null,
      codex: null,
      antigravity: null,
      opencode_go: null,
      ...providers,
    } as UsageSummaryNode["providers"],
  };
}

const CLAUDE_QUOTAS = [
  quota({ id: "claude:short", label: "5시간", window: "5h", remainingPercent: 60 }),
  quota({ id: "claude:weekly", label: "7일", window: "7d", remainingPercent: 40 }),
  quota({ id: "claude:weekly_scoped:fable", label: "Fable", window: "7d", remainingPercent: 90 }),
];

const OPENCODE_QUOTAS = [
  quota({ id: "opencode:short", label: "5시간", window: "5h", remainingPercent: 70 }),
  quota({ id: "opencode:weekly", label: "7일", window: "168h", remainingPercent: 55 }),
  quota({ id: "opencode:monthly", label: "월간", window: "monthly", remainingPercent: 30 }),
];

function data(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const LEGACY_ACCOUNTS = { mode: "legacy" as const, accounts: [], pool: null, fable_pool: null };

function legacyRequest(overrides: (path: string) => Response | null = () => null) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    const custom = overrides(path);
    if (custom) return custom;
    if (path.endsWith("/claude-auth/accounts")) return data(LEGACY_ACCOUNTS);
    if (path.endsWith("/claude-auth/profile")) {
      return data({ account: { email: "legacy@example.invalid", display_name: "레거시 계정", has_claude_max: true } });
    }
    return data({ has_token: true });
  });
}

function cellView(cell: Element | null) {
  if (!cell) return null;
  return {
    name: cell.querySelector(".c724-quota-name")?.textContent ?? "",
    percent: cell.querySelector(".c724-quota-pct")?.textContent ?? "",
  };
}

function rowCells(row: Element | null): Array<ReturnType<typeof cellView>> {
  if (!row) return [];
  return Array.from(row.querySelectorAll(".c724-quota-cell")).map((cell) => cellView(cell));
}

describe("NodeProvidersPanel", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    flowMock.current = {
      tokenStatus: { has_token: true },
      loadingStatus: false,
      error: null,
      showCodeInput: false,
      authUrl: null,
      codeValue: "",
      submitting: false,
      handleLogin: vi.fn(),
      handleSubmitCode: vi.fn(),
      handleCancelCode: vi.fn(),
      handleDeleteToken: vi.fn(),
      refreshStatus: vi.fn(),
    };
    host = document.createElement("div");
    document.body.append(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  });

  async function settle() {
    for (let index = 0; index < 8; index += 1) {
      await act(async () => {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  async function mount(
    node: UsageSummaryNode | null,
    request: ReturnType<typeof legacyRequest>,
    { loading = false }: { loading?: boolean } = {},
  ) {
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <NodeProvidersPanel nodeId="node-a" request={request as unknown as typeof fetch} node={node} loading={loading} />
      </QueryClientProvider>,
    ));
    await settle();
  }

  function rowOf(providerId: string) {
    return host.querySelector(`[data-provider-id="${providerId}"]`);
  }

  it("lists Claude, OpenCode Go, Codex, Antigravity in that order", async () => {
    await mount(summaryNode({
      claude: provider(CLAUDE_QUOTAS),
      opencode_go: provider(OPENCODE_QUOTAS),
      codex: provider([quota({ id: "codex:weekly", label: "7일", window: "168h", remainingPercent: 80 })]),
      antigravity: provider([
        quota({ id: "antigravity:short", label: "5시간", window: "5h", remainingPercent: 20 }),
        quota({ id: "antigravity:weekly", label: "7일", window: "7d", remainingPercent: 10 }),
      ]),
    }), legacyRequest());

    const ids = Array.from(host.querySelectorAll<HTMLElement>("[data-provider-id]"))
      .map((element) => element.dataset.providerId);
    expect(ids).toEqual(["claude", "opencode_go", "codex", "antigravity"]);
  });

  it("keeps three gauge columns and puts a lone Codex weekly quota in the second column", async () => {
    await mount(summaryNode({
      codex: provider([quota({ id: "codex:weekly", label: "7일", window: "168h", remainingPercent: 80 })]),
    }), legacyRequest());

    const cells = rowOf("codex")!.querySelectorAll<HTMLElement>(".c724-quota-cell");
    expect(cells).toHaveLength(3);
    expect(cellView(cells[0]!)).toEqual({ name: "", percent: "" });
    expect(cellView(cells[1]!)).toEqual({ name: "7일", percent: "20%" });
    expect(cellView(cells[2]!)).toEqual({ name: "", percent: "" });
  });

  it("labels the OpenCode Go monthly window as 월간 in the third column", async () => {
    await mount(summaryNode({ opencode_go: provider(OPENCODE_QUOTAS) }), legacyRequest());

    const cells = rowCells(rowOf("opencode_go"));
    expect(cells.map((cell) => cell?.name)).toEqual(["5시간", "7일", "월간"]);
    expect(cells.map((cell) => cell?.percent)).toEqual(["30%", "45%", "70%"]);
  });

  it("shows a one-line 미설정 row without gauges for a not_configured provider", async () => {
    await mount(summaryNode({
      opencode_go: provider([], { status: "not_configured" }),
      antigravity: provider([], { status: "not_configured" }),
    }), legacyRequest());

    const row = rowOf("opencode_go")!;
    expect(row.textContent).toContain("미설정");
    expect(row.querySelectorAll(".c724-quota-cell")).toHaveLength(0);
    expect(row.querySelectorAll(".c724-quota-grid")).toHaveLength(0);
  });

  it("shows only the 조회 오류 badge for an error provider", async () => {
    await mount(summaryNode({
      antigravity: provider([], { status: "error" }),
    }), legacyRequest());

    const row = rowOf("antigravity")!;
    expect(row.textContent).toContain("조회 오류");
    expect(row.textContent).not.toContain("사용량을");
    expect(row.querySelectorAll(".c724-quota-cell")).toHaveLength(0);
  });

  it("omits rows for providers the summary reports as null", async () => {
    await mount(summaryNode({
      opencode_go: provider(OPENCODE_QUOTAS),
    }), legacyRequest());

    expect(rowOf("opencode_go")).not.toBeNull();
    expect(rowOf("codex")).toBeNull();
    expect(rowOf("antigravity")).toBeNull();
    expect(host.textContent).not.toContain("조회 오류");
    expect(host.textContent).not.toContain("미설정");
  });

  it("keeps the Claude row when the summary has no claude provider, and skips the gauge line", async () => {
    await mount(summaryNode({}), legacyRequest());

    const row = rowOf("claude")!;
    expect(row).not.toBeNull();
    expect(row.querySelector(".c724-quota-grid")).toBeNull();
    expect(host.querySelectorAll("[data-provider-id]")).toHaveLength(1);
  });

  it("renders the gauges of the summary claude provider on the legacy Claude row", async () => {
    await mount(summaryNode({ claude: provider(CLAUDE_QUOTAS) }), legacyRequest());

    const cells = rowCells(rowOf("claude"));
    expect(cells.map((cell) => cell?.name)).toEqual(["5시간", "7일", "Fable"]);
    expect(cells.map((cell) => cell?.percent)).toEqual(["40%", "60%", "10%"]);
  });

  it("keeps the legacy Claude account actions and offers no 사용량 button", async () => {
    const request = legacyRequest();
    await mount(summaryNode({ claude: provider(CLAUDE_QUOTAS) }), request);

    const row = rowOf("claude")!;
    expect(row.textContent).toContain("legacy@example.invalid");
    expect(row.textContent).not.toContain("사용량");

    const deleteCap = row.querySelector<HTMLButtonElement>('button[aria-label="토큰 삭제"]');
    const reloginCap = row.querySelector<HTMLButtonElement>('button[aria-label="재로그인"]');
    expect(deleteCap).not.toBeNull();
    expect(reloginCap).not.toBeNull();

    await act(async () => deleteCap!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(flowMock.current.handleDeleteToken).toHaveBeenCalled();

    const callsAfterMount = request.mock.calls.map(([input]) => String(input));
    expect(callsAfterMount.some((path) => path.endsWith("/provider-usage"))).toBe(false);
  });

  it("starts the legacy login when no token is stored", async () => {
    flowMock.current = { ...flowMock.current, tokenStatus: { has_token: false } };
    await mount(summaryNode({}), legacyRequest());

    const row = rowOf("claude")!;
    const loginButton = Array.from(row.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("로그인"));
    expect(loginButton).toBeDefined();

    await act(async () => loginButton!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(flowMock.current.handleLogin).toHaveBeenCalled();
  });

  it("puts the pool accounts behind the pool header instead of the legacy login", async () => {
    const request = legacyRequest((path) => path.endsWith("/claude-auth/accounts")
      ? data({
        mode: "pool",
        accounts: [
          { id: "acc-1", email: "main@example.invalid", priority: 1, disabled: false, plan: "Max 20x", usage: null, session_count: 2, last_seen_at: null, needs_relogin: false },
        ],
        pool: { available_count: 1, total_count: 1, best_weekly_remaining_percent: 88, best_weekly_resets_at: null, earliest_available_at: null },
        fable_pool: null,
      })
      : null);
    await mount(summaryNode({ claude: provider(CLAUDE_QUOTAS) }), request);

    const row = rowOf("claude")!;
    expect(row.querySelector(".c724-account-email")?.textContent).toBe("Claude");
    expect(row.querySelector(".c724-pool-summary")?.textContent).toBe("1/1 가용");
    expect(row.textContent).toContain("계정 1");
    expect(row.textContent).not.toContain("Anthropic 인증");
    expect(rowCells(row).map((cell) => cell?.name)).toEqual(["5시간", "7일", "Fable"]);
  });

  it("falls back to the legacy Claude row when the pool accounts API is missing", async () => {
    const request = legacyRequest((path) => path.endsWith("/claude-auth/accounts")
      ? data({ code: "not_found", message: "Not found" }, 404)
      : null);
    await mount(summaryNode({ claude: provider(CLAUDE_QUOTAS) }), request);

    const row = host.querySelector('[data-testid="legacy-claude-row"]');
    expect(row).not.toBeNull();
    // 스켈레톤에 갇히지 않고 토큰 삭제와 재로그인을 계속 쓸 수 있어야 한다.
    expect(host.querySelector('[data-testid="provider-quota-skeleton"]')).toBeNull();
    expect(row!.querySelector('button[aria-label="토큰 삭제"]')).not.toBeNull();
    expect(row!.querySelector('button[aria-label="재로그인"]')).not.toBeNull();
  });

  it("keeps the Claude row and shows a gauge skeleton while the summary loads", async () => {
    await mount(null, legacyRequest(), { loading: true });

    const row = rowOf("claude")!;
    expect(row).not.toBeNull();
    expect(row.querySelector('[data-testid="provider-quota-skeleton"]')).not.toBeNull();
    expect(host.textContent).not.toContain("로딩 중");
    expect(host.querySelectorAll("[data-provider-id]")).toHaveLength(1);
  });
});
