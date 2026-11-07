/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeClaudeAuthPanel } from "./NodeClaudeAuthPanel";
import { NodeClaudeAuthGate } from "./NodeClaudeAuthGate";

vi.mock("../hooks/useClaudeAuthFlow", () => ({
  useClaudeAuthFlow: () => ({
    loadingStatus: false,
    tokenStatus: { has_token: false },
    showCodeInput: false,
    authUrl: null,
    codeValue: "",
    setCodeValue: vi.fn(),
    handleSubmitCode: vi.fn(),
    handleCancelCode: vi.fn(),
    submitting: false,
    error: null,
    handleLogin: vi.fn(),
    handleDeleteToken: vi.fn(),
  }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const emptyLegacy = {
  mode: "legacy",
  accounts: [],
  pool: null,
  fable_pool: null,
};

const poolList = {
  mode: "pool",
  accounts: [{
    id: "account-a",
    email: "first@example.test",
    plan: "Pro",
    enabled: true,
    priority: 1,
    auth_state: "ok",
    usage: { five_hour: null, seven_day: null, fable_weekly: null },
    observed_at: null,
    blocked: null,
    active_sessions: 0,
  }],
  pool: {
    available_count: 1,
    total_count: 1,
    best_weekly_remaining_percent: null,
    best_weekly_resets_at: null,
    earliest_available_at: null,
  },
  fable_pool: null,
} as const;

function quota(id: string, label: string, usedPercent: number, resetAt: number) {
  return {
    id, label, window: null, unit: null, used: null, remaining: null, limit: null,
    usedPercent, remainingPercent: 100 - usedPercent, resetAt, model: null, source: null,
  };
}

const providerUsage = {
  generatedAt: "",
  providers: {
    claude: { status: "auto", source: "", planType: "Max", quotas: [quota("claude:7d", "7일", 50, 1_794_182_400)] },
    codex: { status: "auto", source: "codex-api", planType: "Plus", quotas: [quota("codex:7d", "7일", 42, 1_794_182_400)] },
    antigravity: { status: "auto", source: "agy:/usage", planType: null, quotas: [quota("antigravity:gemini:5h", "5시간", 12, 1_793_958_181)] },
    opencode_go: {
      status: "auto",
      source: "https://opencode.ai/inference/go/v1/usage",
      sourceKind: "remote",
      planType: "구독",
      quotas: [
        quota("opencode_go:rolling", "5시간", 2, 1_793_958_181),
        quota("opencode_go:weekly", "7일", 18, 1_794_182_400),
        quota("opencode_go:monthly", "월", 9, 1_796_562_656),
      ],
    },
  },
};

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function setup() {
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { host, root, client };
}

async function unmount(host: HTMLDivElement, root: Root, client: QueryClient) {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
}

describe("NodeClaudeAuthGate", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    ({ host, root, client } = setup());
  });

  afterEach(async () => {
    await unmount(host, root, client);
  });

  it.each([
    ["legacy mode", () => jsonResponse(emptyLegacy)],
    ["an unavailable accounts route", () => new Response("not found", { status: 404 })],
    ["a network error", () => Promise.reject(new Error("offline"))],
  ])("keeps the existing Claude panel unchanged for %s", async (_label, response) => {
    const requestMock = vi.fn<typeof fetch>(async () => await response());
    const request = requestMock;
    const baseline = document.createElement("div");
    const baselineRoot = createRoot(baseline);
    await act(async () => baselineRoot.render(<NodeClaudeAuthPanel nodeId="node-a" request={request} />));
    const existingMarkup = baseline.innerHTML;
    await act(async () => baselineRoot.unmount());

    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <NodeClaudeAuthGate nodeId="node-a" request={request} />
      </QueryClientProvider>,
    ));
    await act(async () => {
      await vi.waitFor(() => expect(host.innerHTML).toBe(existingMarkup));
    });

    expect(host.innerHTML).toBe(existingMarkup);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(String(requestMock.mock.calls[0]?.[0])).toBe("/api/nodes/node-a/claude-auth/accounts");
  });

  it("shows the pool panel only after an accounts response reports pool mode", async () => {
    const request = vi.fn(async () => jsonResponse(poolList)) as unknown as typeof fetch;

    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <NodeClaudeAuthGate nodeId="node-a" request={request} />
      </QueryClientProvider>,
    ));
    await act(async () => {
      await vi.waitFor(() => expect(host.querySelector('[data-testid="claude-account-pool-panel"]')).not.toBeNull());
    });

    expect(host.querySelector('[data-testid="claude-account-pool-panel"]')).not.toBeNull();
    expect(host.textContent).toContain("first@example.test");
    expect(host.textContent).not.toContain("Claude Code 크레덴셜");
  });

  it("shows Codex, Antigravity and OpenCode Go usage under the pool panel", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/nodes/node-a/claude-auth/accounts") return jsonResponse(poolList);
      if (path === "/api/nodes/node-a/provider-usage") return jsonResponse(providerUsage);
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <NodeClaudeAuthGate nodeId="node-a" request={request} />
      </QueryClientProvider>,
    ));
    await act(async () => {
      await vi.waitFor(() => expect(host.querySelector('[data-testid="node-provider-usage-panel"]')).not.toBeNull());
    });

    await act(async () => {
      Array.from(host.querySelectorAll("button")).find(button => button.textContent === "사용량")!.click();
    });
    await act(async () => {
      await vi.waitFor(() => expect(host.textContent).toContain("OpenCode Go"));
    });

    expect(host.textContent).toContain("Codex");
    expect(host.textContent).toContain("Antigravity");
    expect(host.textContent).toContain("5시간");
    expect(host.textContent).toContain("7일");
    expect(host.textContent).toContain("월");
    expect(host.textContent).not.toContain("Claude Code");
  });

  it("shows a provider usage failure inside the pool node panel", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/nodes/node-a/claude-auth/accounts") return jsonResponse(poolList);
      if (path === "/api/nodes/node-a/provider-usage") return new Response("provider usage unavailable", { status: 500 });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <NodeClaudeAuthGate nodeId="node-a" request={request} />
      </QueryClientProvider>,
    ));
    await act(async () => {
      await vi.waitFor(() => expect(host.querySelector('[data-testid="node-provider-usage-panel"]')).not.toBeNull());
    });

    await act(async () => {
      Array.from(host.querySelectorAll("button")).find(button => button.textContent === "사용량")!.click();
    });
    await act(async () => {
      await vi.waitFor(() => expect(host.textContent).toContain("provider usage unavailable"));
    });
  });
});
