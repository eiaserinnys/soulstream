import { describe, expect, it, vi } from "vitest";
import {
  ClaudeAccountReloginNotifier,
  type ClaudeAccountReloginAlert,
} from "../src/usage/claude_account_relogin_notifier.js";
import type { UsageSummarySnapshot } from "../src/usage/usage_summary_service.js";

type AuthState = "ok" | "idle" | "needs_relogin" | "logging_in";

function snapshot(
  state: AuthState,
  options: { nodeId?: string; accountId?: string; enabled?: boolean } = {},
): UsageSummarySnapshot {
  const account = {
    id: options.accountId ?? "account-a",
    email: "a@example.com",
    plan: null,
    enabled: options.enabled ?? true,
    priority: null,
    auth_state: state,
    usage: { five_hour: null, seven_day: null, fable_weekly: null },
    observed_at: null,
    blocked: null,
    active_sessions: 0,
  };
  return {
    generatedAt: "2026-10-28T00:00:00.000Z",
    collectedAt: "2026-10-28T00:00:00.000Z",
    nodes: [{
      nodeId: options.nodeId ?? "node-a",
      fetchedAt: null,
      stale: false,
      staleSince: null,
      providers: { claude: { status: "auto", accounts: [account] } },
    }],
  } as unknown as UsageSummarySnapshot;
}

function createNotifier() {
  const notify = vi.fn<(alert: ClaudeAccountReloginAlert) => void>();
  return { notify, notifier: new ClaudeAccountReloginNotifier(notify) };
}

describe("ClaudeAccountReloginNotifier", () => {
  it("notifies once when an account turns needs_relogin and not again for the same state", () => {
    const { notify, notifier } = createNotifier();

    notifier.observe(snapshot("ok"));
    notifier.observe(snapshot("needs_relogin"));
    notifier.observe(snapshot("needs_relogin"));

    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith({
      nodeId: "node-a",
      accountId: "account-a",
      accountEmail: "a@example.com",
    });
  });

  it("does not notify for an account first seen as needs_relogin", () => {
    const { notify, notifier } = createNotifier();

    notifier.observe(snapshot("needs_relogin"));

    expect(notify).not.toHaveBeenCalled();
  });

  it("does not notify for a disabled account", () => {
    const { notify, notifier } = createNotifier();

    notifier.observe(snapshot("ok", { enabled: false }));
    notifier.observe(snapshot("needs_relogin", { enabled: false }));

    expect(notify).not.toHaveBeenCalled();
  });

  it("does not notify when needs_relogin follows logging_in", () => {
    const { notify, notifier } = createNotifier();

    notifier.observe(snapshot("logging_in"));
    notifier.observe(snapshot("needs_relogin"));

    expect(notify).not.toHaveBeenCalled();
  });

  it("notifies again after the account returned to ok and turned needs_relogin once more", () => {
    const { notify, notifier } = createNotifier();

    notifier.observe(snapshot("ok"));
    notifier.observe(snapshot("needs_relogin"));
    notifier.observe(snapshot("ok"));
    notifier.observe(snapshot("needs_relogin"));

    expect(notify).toHaveBeenCalledTimes(2);
  });
});
