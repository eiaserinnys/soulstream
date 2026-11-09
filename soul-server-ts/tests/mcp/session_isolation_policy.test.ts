/**
 * restricted 실행 정책 정본(§4) 검증.
 *
 * 136 도구의 분류(100/29/6/1), inventory fixture와의 전수 일치, digest 안정성,
 * 잘못된 정책의 거부, loader의 실패 처리(빈 정책 fallback 금지), 번들 인라인
 * 기본 provider와 리포 JSON의 동일성.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { ISOLATION_POLICY_UNAVAILABLE } from "../../src/security/session_execution_policy.js";
import {
  computeIsolationPolicyDigest,
  createIsolationPolicyProvider,
  IsolationPolicyFileError,
  loadIsolationPolicyFile,
  parseIsolationPolicy,
} from "../../src/security/session_isolation_policy.js";

const policyPath = fileURLToPath(
  new URL("../../src/policies/session-isolation.json", import.meta.url),
);
const policyText = readFileSync(policyPath, "utf8");
const rawPolicy = JSON.parse(policyText) as Record<string, unknown> & {
  tools: Record<string, { category: string; guard?: string }>;
};

const fixturePath = fileURLToPath(new URL("./fixtures/tool_inventory.internal.json", import.meta.url));
const fixtureNames = (JSON.parse(readFileSync(fixturePath, "utf8")) as Array<{ name: string }>)
  .map((tool) => tool.name);

function clonePolicy(): Record<string, unknown> {
  return JSON.parse(policyText) as Record<string, unknown>;
}

function namesByCategory(policy: { tools: Record<string, { category: string }> }, category: string): string[] {
  return Object.entries(policy.tools)
    .filter(([, entry]) => entry.category === category)
    .map(([name]) => name)
    .sort();
}

describe("session isolation policy canonical file", () => {
  it("classifies all 136 inventory tools exactly once (100 allow / 29 deny / 6 guarded / 1 inherit)", () => {
    const policy = parseIsolationPolicy(rawPolicy);
    const names = Object.keys(policy.tools).sort();

    expect(names).toHaveLength(136);
    expect(names).toEqual([...fixtureNames].sort());
    expect(namesByCategory(policy, "allow")).toHaveLength(100);
    expect(namesByCategory(policy, "deny")).toHaveLength(29);
    expect(namesByCategory(policy, "guarded")).toHaveLength(6);
    expect(namesByCategory(policy, "inherit")).toHaveLength(1);

    const categories = ["allow", "deny", "guarded", "inherit"] as const;
    const buckets = categories.map((category) => new Set(namesByCategory(policy, category)));
    expect(buckets.reduce((sum, bucket) => sum + bucket.size, 0)).toBe(136);
    for (let left = 0; left < buckets.length; left += 1) {
      for (let right = left + 1; right < buckets.length; right += 1) {
        const intersection = [...buckets[left]].filter((name) => buckets[right].has(name));
        expect(intersection).toEqual([]);
      }
    }
    expect(names.every((name) => policy.tools[name] !== undefined)).toBe(true);
  });

  it("pins the six guards, the inherit rule and the read-only observation tool", () => {
    const policy = parseIsolationPolicy(rawPolicy);
    expect(policy.tools["create_card"]).toEqual({ category: "guarded", guard: "draft-card" });
    expect(policy.tools["set_card_status"]).toEqual({ category: "guarded", guard: "card-status" });
    expect(policy.tools["create_worktree"]).toEqual({ category: "guarded", guard: "worktree-create" });
    expect(policy.tools["remove_worktree"]).toEqual({ category: "guarded", guard: "owned-worktree" });
    expect(policy.tools["delete_worktree_branch"]).toEqual({ category: "guarded", guard: "owned-worktree" });
    expect(policy.tools["send_message_to_session"]).toEqual({ category: "guarded", guard: "message-recipient" });
    expect(policy.tools["create_agent_session"]).toEqual({ category: "inherit", guard: "create-local-session" });
    expect(policy.tools["observe_node_services"]).toEqual({ category: "allow" });
  });

  it("keeps digest stable across key order and changes it when a classification changes", () => {
    const policy = parseIsolationPolicy(rawPolicy);
    const digest = computeIsolationPolicyDigest(policy);
    expect(computeIsolationPolicyDigest(parseIsolationPolicy(rawPolicy))).toBe(digest);

    const reorderedTools = Object.fromEntries(
      Object.entries(rawPolicy.tools).reverse(),
    );
    const reordered = {
      network: rawPolicy.network,
      testDatabases: rawPolicy.testDatabases,
      filesystem: rawPolicy.filesystem,
      localMcp: rawPolicy.localMcp,
      tools: reorderedTools,
      version: rawPolicy.version,
    };
    expect(computeIsolationPolicyDigest(parseIsolationPolicy(reordered))).toBe(digest);

    const changed = clonePolicy() as typeof rawPolicy;
    changed.tools["observe_node_services"] = { category: "deny" };
    expect(computeIsolationPolicyDigest(parseIsolationPolicy(changed))).not.toBe(digest);
  });

  it("serves the bundled policy with the same policy and digest as the canonical file", () => {
    // 경로 없는 기본 provider는 번들에 인라인된 정본 JSON을 쓰고, 파일을
    // 경로로 읽은 결과와 정책·digest가 같아야 한다.
    const bundled = createIsolationPolicyProvider().get();
    const fromFile = loadIsolationPolicyFile(policyPath);

    expect(bundled.policy).toEqual(fromFile.policy);
    expect(bundled.digest).toBe(fromFile.digest);
  });
});

describe("isolation policy validation", () => {
  it.each([
    ["wrong version", (policy: Record<string, unknown>) => { policy.version = 2; }],
    ["unknown category", (policy: Record<string, unknown>) => {
      (policy.tools as Record<string, unknown>)["observe_node_services"] = { category: "maybe" };
    }],
    ["unknown guard", (policy: Record<string, unknown>) => {
      (policy.tools as Record<string, unknown>)["create_card"] = { category: "guarded", guard: "unknown" };
    }],
    ["extra field on allow", (policy: Record<string, unknown>) => {
      (policy.tools as Record<string, unknown>)["observe_node_services"] = { category: "allow", guard: "draft-card" };
    }],
    ["empty tools", (policy: Record<string, unknown>) => { policy.tools = {}; }],
    ["extra top-level field", (policy: Record<string, unknown>) => { policy.extra = true; }],
    ["invalid CIDR", (policy: Record<string, unknown>) => {
      const network = policy.network as Record<string, unknown>;
      network.deniedIpv4 = ["10.0.0.0/33"];
    }],
    ["wrong required server id", (policy: Record<string, unknown>) => {
      const localMcp = policy.localMcp as Record<string, unknown>;
      localMcp.requiredServerId = "other";
    }],
    ["wrong worktree root literal", (policy: Record<string, unknown>) => {
      const filesystem = policy.filesystem as Record<string, unknown>;
      filesystem.sessionWorktreeRelativeRoot = ".projects";
    }],
  ])("rejects %s", (_label, mutate) => {
    const broken = clonePolicy();
    mutate(broken);
    expect(() => parseIsolationPolicy(broken)).toThrow(IsolationPolicyFileError);
  });

  it("refuses to fall back to an empty policy when the file is unreadable or invalid", () => {
    const unreadable = () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    expect(() => loadIsolationPolicyFile("/nonexistent/session-isolation.json", { readFile: unreadable }))
      .toThrow(IsolationPolicyFileError);
    try {
      loadIsolationPolicyFile("/nonexistent/session-isolation.json", { readFile: unreadable });
    } catch (error) {
      expect((error as IsolationPolicyFileError).code).toBe(ISOLATION_POLICY_UNAVAILABLE);
    }

    expect(() => loadIsolationPolicyFile(policyPath, { readFile: () => "{not json" }))
      .toThrow(IsolationPolicyFileError);
    expect(() => loadIsolationPolicyFile(policyPath, { readFile: () => JSON.stringify({ version: 1 }) }))
      .toThrow(IsolationPolicyFileError);
  });

  it("caches successful loads only and retries after a failure", () => {
    const readFile = vi.fn(() => policyText);
    const provider = createIsolationPolicyProvider({ path: "/policy.json", readFile });
    const first = provider.get();
    const second = provider.get();
    expect(second).toBe(first);
    expect(readFile).toHaveBeenCalledTimes(1);

    const flaky = vi.fn()
      .mockImplementationOnce(() => { throw new Error("temporary"); })
      .mockImplementation(() => policyText);
    const retrying = createIsolationPolicyProvider({ path: "/policy.json", readFile: flaky });
    expect(() => retrying.get()).toThrow(IsolationPolicyFileError);
    expect(retrying.get().policy.version).toBe(1);
    expect(flaky).toHaveBeenCalledTimes(2);
  });
});
