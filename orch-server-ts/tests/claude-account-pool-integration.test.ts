import { describe, expect, it } from "vitest";

import { UsageSummaryService } from "../src/usage/usage_summary_service.js";
import { registerUsageSummaryRoutes } from "../src/usage/usage_summary_routes.js";
import type { UsageSummarySnapshot } from "../src/usage/usage_summary_service.js";
import { createClaudeAuthHarness } from "./node-claude-auth-test-helpers.js";

describe("Claude account-pool route and usage-summary integration", () => {
  it("publishes refreshed PATCH, DELETE, login-done, and stale-failure snapshots on a persistent SSE stream", async () => {
    const originalAccount = poolAccount("11111111-1111-4111-8111-111111111111");
    const loggedInAccount = poolAccount("22222222-2222-4222-8222-222222222222");
    let accounts = [originalAccount];
    let failRefresh = false;
    let service: UsageSummaryService;
    const harness = createClaudeAuthHarness({
      claudeAccountPoolEnabled: true,
      usageSummary: { refreshNode: (nodeId) => service.refreshNode(nodeId) },
      ackFor: (message) => {
        if (message.type === "provider_usage_get") {
          if (failRefresh && message.provider === "claude") {
            return { success: false, error: { code: "provider_usage_failed", message: "private worker detail" } };
          }
          const current = providerUsage(accounts);
          return message.provider === "claude"
            ? { success: true, data: current }
            : {
                success: true,
                data: {
                  providers: {
                    claude: current,
                    codex: scalarProviderUsage(),
                    antigravity: scalarProviderUsage(),
                  },
                },
              };
        }
        if (message.type === "claude_auth_account_update") {
          accounts = accounts.map((account) => account.id === message.account_id
            ? { ...account, enabled: message.enabled === true }
            : account);
          return { success: true, data: accountList(accounts) };
        }
        if (message.type === "claude_auth_account_delete") {
          accounts = accounts.filter((account) => account.id !== message.account_id);
          return { success: true, data: { deferred: false, accounts: [], pool: null } };
        }
        if (message.type === "claude_auth_login_submit_code") {
          accounts = [loggedInAccount];
          return {
            success: true,
            data: {
              login_id: message.login_id,
              account_id: loggedInAccount.id,
              state: "done",
              auth_url: null,
              expires_at: "2026-10-28T05:00:00.000Z",
              error: null,
            },
          };
        }
        return {};
      },
    });
    service = new UsageSummaryService({
      registry: harness.registry,
      bridge: harness.bridge,
      pollIntervalMs: 300_000,
      sharedAccountGroups: [],
      now: () => new Date("2026-10-28T04:00:00.000Z"),
    });
    registerUsageSummaryRoutes(harness.app, { service });
    await service.collectOnce();

    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      await harness.app.listen({ host: "127.0.0.1", port: 0 });
      const address = harness.app.server.address();
      if (address === null || typeof address === "string") throw new Error("Test server did not bind a TCP port.");
      const origin = `http://127.0.0.1:${address.port}`;
      const streamResponse = await fetch(`${origin}/api/usage/stream`, { signal: controller.signal });
      expect(streamResponse.status).toBe(200);
      expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");
      if (streamResponse.body === null) throw new Error("Usage stream body is missing.");
      reader = streamResponse.body.getReader();
      const buffered = { text: "" };
      await readUsageSummary(reader, buffered, "initial stream snapshot");

      const patchResponse = await fetch(`${origin}/api/nodes/fake-node/claude-auth/accounts/${originalAccount.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(patchResponse.status).toBe(200);
      await expectSummaryAndStream(origin, reader, buffered, { accountId: originalAccount.id, enabled: false });

      const deleteResponse = await fetch(`${origin}/api/nodes/fake-node/claude-auth/accounts/${originalAccount.id}`, {
        method: "DELETE",
      });
      expect(deleteResponse.status).toBe(200);
      await expectSummaryAndStream(origin, reader, buffered, { accountIds: [] });

      const loginResponse = await fetch(`${origin}/api/nodes/fake-node/claude-auth/logins/login-a/code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "integration-login-code" }),
      });
      expect(loginResponse.status).toBe(200);
      expect(await loginResponse.json()).toMatchObject({ state: "done" });
      await expectSummaryAndStream(origin, reader, buffered, { accountIds: [loggedInAccount.id] });

      failRefresh = true;
      const failedRefresh = await fetch(`${origin}/api/nodes/fake-node/claude-auth/accounts/${loggedInAccount.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(failedRefresh.status).toBe(502);
      expect(await failedRefresh.json()).toEqual({
        code: "node_command_failed",
        message: "Claude 계정 노드 요청을 처리하지 못했습니다.",
      });
      await expectSummaryAndStream(origin, reader, buffered, {
        accountIds: [loggedInAccount.id],
        stale: true,
      });
    } finally {
      controller.abort();
      await reader?.cancel().catch(() => undefined);
      await harness.app.close();
    }
  }, 60_000);
});

async function expectSummaryAndStream(
  origin: string,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffered: { text: string },
  expected: { accountId?: string; accountIds?: readonly string[]; enabled?: boolean; stale?: boolean },
): Promise<void> {
  const response = await fetch(`${origin}/api/usage/summary`);
  expect(response.status).toBe(200);
  const snapshot = await response.json() as UsageSummarySnapshot;
  const event = await readUsageSummary(reader, buffered, "mutation snapshot");
  expect(event).toEqual(snapshot);
  const node = snapshot.nodes.find((candidate) => candidate.nodeId === "fake-node");
  expect(node?.stale).toBe(expected.stale ?? false);
  const provider = node?.providers.claude;
  expect(provider?.mode).toBe("pool");
  if (expected.accountIds !== undefined) {
    expect(provider?.accounts?.map((account) => account.id)).toEqual(expected.accountIds);
  }
  if (expected.accountId !== undefined) {
    expect(provider?.accounts).toContainEqual(expect.objectContaining({
      id: expected.accountId,
      ...(expected.enabled === undefined ? {} : { enabled: expected.enabled }),
    }));
  }
}

async function readUsageSummary(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffered: { text: string },
  label: string,
): Promise<UsageSummarySnapshot> {
  while (true) {
    const boundary = buffered.text.indexOf("\n\n");
    if (boundary >= 0) {
      const frame = buffered.text.slice(0, boundary);
      buffered.text = buffered.text.slice(boundary + 2);
      const data = frame.split("\n").find((line) => line.startsWith("data: "));
      if (data !== undefined) {
        const parsed = JSON.parse(data.slice(6)) as UsageSummarySnapshot & { type?: string };
        expect(parsed.type).toBe("usage_summary");
        delete parsed.type;
        return parsed;
      }
      continue;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 5_000);
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
    if (chunk.done) throw new Error("Usage summary SSE stream ended before the expected snapshot.");
    buffered.text += new TextDecoder().decode(chunk.value, { stream: true });
  }
}

function poolAccount(id: string) {
  return {
    id,
    email: `${id}@example.com`,
    plan: "max",
    enabled: true,
    priority: 0,
    auth_state: "ok" as const,
    usage: { five_hour: null, seven_day: null, fable_weekly: null },
    observed_at: "2026-10-28T03:00:00.000Z",
    blocked: null,
    active_sessions: 0,
  };
}

function accountList(accounts: readonly ReturnType<typeof poolAccount>[]) {
  const total = accounts.filter((account) => account.enabled).length;
  return {
    mode: "pool",
    accounts,
    pool: {
      available_count: total,
      total_count: total,
      best_weekly_remaining_percent: 80,
      best_weekly_resets_at: null,
      earliest_available_at: null,
    },
    fable_pool: {
      available_count: total,
      total_count: total,
      best_weekly_remaining_percent: 70,
      best_weekly_resets_at: null,
      earliest_available_at: null,
    },
  };
}

function providerUsage(accounts: readonly ReturnType<typeof poolAccount>[]) {
  return {
    status: "auto",
    weeklyUsedPercent: 20,
    weeklyResetAt: 1_761_600_000,
    shortUsedPercent: 30,
    shortResetAt: 1_761_300_000,
    quotas: [],
    ...accountList(accounts),
  };
}

function scalarProviderUsage() {
  return {
    status: "auto",
    weeklyUsedPercent: 20,
    weeklyResetAt: null,
    shortUsedPercent: 30,
    shortResetAt: null,
    quotas: [],
  };
}
