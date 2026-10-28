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
});
