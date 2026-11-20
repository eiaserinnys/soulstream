import { describe, expect, it } from "vitest";

import {
  selectBestCandidate,
  type SelectCandidateParams,
  type SelectableAccountCandidate,
} from "../../src/claude_accounts/selector.js";
import type { ClaudeAccountUsage } from "../../src/claude_accounts/types.js";

// 카드 #1734: 98% 미만 층에서 노드 로컬 계정을 중앙 계정보다 먼저 쓴다.
// affinity와 ok>idle은 로컬 먼저보다 앞이고, 98% 이상 층과 적격 필터는 그대로다.
// 다만 중앙에 묶인 세션은 98% 미만 층에 ok 로컬이 있으면 affinity를 보지 않는다.

const NOW_MS = Date.parse("2026-11-20T01:00:00.000Z");
const MODEL = "claude-sonnet-4-6";

function usage(usedPercent: number | null): ClaudeAccountUsage {
  return {
    five_hour: usedPercent === null ? null : { used_percent: usedPercent, resets_at: null },
    seven_day: null,
    fable_weekly: null,
  };
}

function local(
  id: string,
  overrides: Partial<SelectableAccountCandidate> = {},
): SelectableAccountCandidate {
  return {
    id,
    enabled: true,
    priority: null,
    auth_state: "ok",
    active_sessions: 0,
    usage: usage(10),
    source: "local",
    ...overrides,
  };
}

function central(
  id: string,
  overrides: Partial<SelectableAccountCandidate> = {},
): SelectableAccountCandidate {
  return {
    id,
    enabled: true,
    priority: 0,
    auth_state: "ok",
    active_sessions: 0,
    usage: usage(10),
    source: "central",
    ...overrides,
  };
}

function pick(
  candidates: SelectableAccountCandidate[],
  extra: Partial<SelectCandidateParams> = {},
): string | null {
  return selectBestCandidate({ candidates, model: MODEL, nowMs: NOW_MS, ...extra })?.id ?? null;
}

describe("selectBestCandidate local-first ordering under the 98% cap", () => {
  it("picks a local ok account with no priority over a central ok account with priority 0", () => {
    expect(pick([central("central-a"), local("local-a")])).toBe("local-a");
  });

  it("picks the local account even when its priority number is larger than the central one", () => {
    expect(pick([central("central-a", { priority: 0 }), local("local-a", { priority: 5 })]))
      .toBe("local-a");
  });

  it("treats a candidate without a source field as local", () => {
    const { source: _omitted, ...withoutSource } = local("legacy-local");
    expect(pick([central("central-a"), withoutSource])).toBe("legacy-local");
    // 중앙 affinity 예외에서도 칸 없는 ok 후보를 로컬로 센다.
    expect(pick(
      [central("central-a"), withoutSource],
      { boundAccountId: "central-a", boundTurnId: "turn-1", turnId: "turn-2" },
    )).toBe("legacy-local");
  });

  it("keeps ok before idle: an unmeasured local idle account loses to a central ok account", () => {
    expect(pick([local("local-idle", { auth_state: "idle", usage: usage(null) }), central("central-a")]))
      .toBe("central-a");
  });

  it("returns a session bound to a central account to an ok local account on a later turn", () => {
    expect(pick(
      [local("local-a"), central("central-a")],
      { boundAccountId: "central-a", boundTurnId: "turn-1", turnId: "turn-2" },
    )).toBe("local-a");
  });

  it("keeps a central-bound session on its central account when no local is ok under the cap", () => {
    const centralBound = { boundAccountId: "central-b", boundTurnId: "turn-1", turnId: "turn-2" };
    const centrals = [
      central("central-a", { priority: 0 }),
      central("central-b", { priority: 3 }),
    ];
    const blockedUntil = new Date(NOW_MS + 3_600_000).toISOString();
    // 로컬이 98% 이상
    expect(pick([local("local-a", { usage: usage(99) }), ...centrals], centralBound))
      .toBe("central-b");
    // 로컬이 막힘
    expect(pick([
      local("local-a", { blocks: { all: { resets_at: blockedUntil, observed_at: new Date(NOW_MS).toISOString() } } }),
      ...centrals,
    ], centralBound)).toBe("central-b");
    // 로컬이 idle
    expect(pick([local("local-a", { auth_state: "idle", usage: usage(null) }), ...centrals], centralBound))
      .toBe("central-b");
  });

  it("keeps a local-bound session on its local account even when another local has a smaller priority", () => {
    expect(pick(
      [
        local("local-a", { priority: 5 }),
        local("local-b", { priority: 1 }),
        central("central-a", { priority: 0 }),
      ],
      { boundAccountId: "local-a", boundTurnId: "turn-1", turnId: "turn-2" },
    )).toBe("local-a");
  });

  it("returns the bound central account on a same-turn reselection without sorting", () => {
    expect(pick(
      [local("local-a"), central("central-a")],
      { boundAccountId: "central-a", boundTurnId: "turn-1", turnId: "turn-1" },
    )).toBe("central-a");
  });

  it("keeps the existing priority order among local accounts and among central accounts", () => {
    expect(pick([
      local("local-null"),
      local("local-2", { priority: 2 }),
      local("local-1", { priority: 1 }),
      central("central-0", { priority: 0 }),
    ])).toBe("local-1");
    expect(pick([
      central("central-3", { priority: 3 }),
      central("central-0", { priority: 0 }),
      central("central-null", { priority: null }),
    ])).toBe("central-0");
  });
});

describe("selectBestCandidate falls back to central when local cannot be used", () => {
  it("picks central when the local account is at or above 98% and central is under it", () => {
    expect(pick([local("local-a", { usage: usage(98) }), central("central-a", { usage: usage(60) })]))
      .toBe("central-a");
  });

  it("picks central when the local account is blocked, needs relogin, or disabled", () => {
    const blocked = local("local-a", {
      blocks: { all: { resets_at: new Date(NOW_MS + 3_600_000).toISOString(), observed_at: new Date(NOW_MS).toISOString() } },
    });
    expect(pick([blocked, central("central-a")])).toBe("central-a");
    expect(pick([local("local-a", { auth_state: "needs_relogin" }), central("central-a")]))
      .toBe("central-a");
    expect(pick([local("local-a", { enabled: false }), central("central-a")])).toBe("central-a");
  });

  it("returns to the local account once its block has reset", () => {
    const resetBlock = local("local-a", {
      blocks: { all: { resets_at: new Date(NOW_MS - 1).toISOString(), observed_at: new Date(NOW_MS - 3_600_000).toISOString() } },
    });
    expect(pick([resetBlock, central("central-a")])).toBe("local-a");
  });

  it("picks central on a same-turn reselection after the local account was excluded mid-turn", () => {
    expect(pick(
      [local("local-a"), central("central-a")],
      { boundAccountId: "local-a", boundTurnId: "turn-1", turnId: "turn-1", excludeIds: ["local-a"] },
    )).toBe("central-a");
  });
});

describe("selectBestCandidate at or above the 98% cap ignores source", () => {
  it("picks the lower usage account regardless of local or central", () => {
    expect(pick([local("local-a", { usage: usage(99) }), central("central-a", { usage: usage(98.5) })]))
      .toBe("central-a");
    expect(pick([local("local-a", { usage: usage(98.5) }), central("central-a", { usage: usage(99) })]))
      .toBe("local-a");
  });

  it("still uses priority, not source, when the top-tier usage ties", () => {
    expect(pick([
      local("local-a", { priority: null, usage: usage(99) }),
      central("central-a", { priority: 0, usage: usage(99) }),
    ])).toBe("central-a");
  });
});
