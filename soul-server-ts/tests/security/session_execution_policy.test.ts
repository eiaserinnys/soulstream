import { describe, expect, it, vi } from "vitest";

import type {
  SessionExecutionChain,
  SessionExecutionChainRow,
} from "../../src/db/session_db_types.js";
import {
  ISOLATION_POLICY_UNAVAILABLE,
  IsolationPolicyUnavailableError,
  resolveExecutionSecurityDecision,
  type ExecutionSecurityPolicyPorts,
} from "../../src/security/session_execution_policy.js";

const TRUSTED = new Set(["claude-opus", "codex-6.1-sol", "claude-fable"]);

function row(
  overrides: Partial<SessionExecutionChainRow> & { session_id: string },
): SessionExecutionChainRow {
  return {
    caller_session_id: null,
    model_preset: null,
    model: null,
    agent_id: null,
    ...overrides,
  };
}

function chain(
  root: SessionExecutionChainRow | null,
  ancestors: SessionExecutionChainRow[] = [],
): SessionExecutionChain {
  return { root, ancestors };
}

function makePorts(
  overrides: Partial<ExecutionSecurityPolicyPorts> = {},
): ExecutionSecurityPolicyPorts & {
  readSession: ReturnType<typeof vi.fn>;
  readNodePreset: ReturnType<typeof vi.fn>;
  isTrustedPreset: ReturnType<typeof vi.fn>;
} {
  const ports = {
    platform: "linux" as NodeJS.Platform,
    readSession: vi.fn(async (sessionId: string) =>
      chain(row({ session_id: sessionId }))),
    readNodePreset: vi.fn((_agentId: string | null): string | null => null),
    isTrustedPreset: vi.fn((presetId: string) => TRUSTED.has(presetId)),
    ...overrides,
  };
  return ports as ExecutionSecurityPolicyPorts & {
    readSession: ReturnType<typeof vi.fn>;
    readNodePreset: ReturnType<typeof vi.fn>;
    isTrustedPreset: ReturnType<typeof vi.fn>;
  };
}

describe("session execution policy", () => {
  it("keeps a trusted preset full when the session has no caller", async () => {
    const ports = makePorts();

    await expect(
      resolveExecutionSecurityDecision("s1", "claude-opus", ports),
    ).resolves.toEqual({
      sessionId: "s1",
      tier: "full",
      policyVersion: 1,
      reason: "trusted",
      presetId: "claude-opus",
    });
    expect(ports.readSession).toHaveBeenCalledTimes(1);
    expect(ports.readSession).toHaveBeenCalledWith("s1");
  });

  it("restricts a weak preset", async () => {
    const ports = makePorts();

    await expect(
      resolveExecutionSecurityDecision("s1", "deepseek-flash-4.1", ports),
    ).resolves.toMatchObject({
      tier: "restricted",
      reason: "untrusted-preset",
      presetId: "deepseek-flash-4.1",
    });
  });

  it("restricts a field-less preset", async () => {
    const ports = makePorts();

    await expect(
      resolveExecutionSecurityDecision("s1", "claude-sonnet", ports),
    ).resolves.toMatchObject({
      tier: "restricted",
      reason: "untrusted-preset",
      presetId: "claude-sonnet",
    });
  });

  it("restricts a session that selects no preset at all", async () => {
    const ports = makePorts();

    await expect(
      resolveExecutionSecurityDecision("s1", null, ports),
    ).resolves.toMatchObject({
      tier: "restricted",
      reason: "untrusted-preset",
      presetId: null,
    });
  });

  it("inherits restriction from an untrusted caller", async () => {
    const ports = makePorts({
      readSession: vi.fn(async () => chain(
        row({ session_id: "s1", caller_session_id: "caller" }),
        [row({ session_id: "caller", model_preset: "deepseek-flash-4.1" })],
      )),
    });

    await expect(
      resolveExecutionSecurityDecision("s1", "claude-opus", ports),
    ).resolves.toMatchObject({
      tier: "restricted",
      reason: "inherited",
      presetId: "claude-opus",
    });
  });

  it("keeps a trusted caller chain full", async () => {
    const ports = makePorts({
      readSession: vi.fn(async () => chain(
        row({ session_id: "s1", caller_session_id: "caller" }),
        [row({ session_id: "caller", model_preset: "codex-6.1-sol", caller_session_id: "root" }),
          row({ session_id: "root", model_preset: "claude-fable" })],
      )),
    });

    await expect(
      resolveExecutionSecurityDecision("s1", "claude-opus", ports),
    ).resolves.toMatchObject({ tier: "full", reason: "trusted" });
    expect(ports.readSession).toHaveBeenCalledTimes(1);
  });

  it("resolves an unselected caller through the node profile default", async () => {
    const ports = makePorts({
      readSession: vi.fn(async () => chain(
        row({ session_id: "s1", caller_session_id: "caller" }),
        [row({ session_id: "caller", agent_id: "seosoyoung" })],
      )),
      readNodePreset: vi.fn((agentId: string | null) =>
        agentId === "seosoyoung" ? "claude-opus" : null),
    });

    await expect(
      resolveExecutionSecurityDecision("s1", "claude-opus", ports),
    ).resolves.toMatchObject({ tier: "full", reason: "trusted" });
    expect(ports.readNodePreset).toHaveBeenCalledWith("seosoyoung");
  });

  it("restricts a raw-model-only caller", async () => {
    const ports = makePorts({
      readSession: vi.fn(async () => chain(
        row({ session_id: "s1", caller_session_id: "caller" }),
        [row({ session_id: "caller", model: "opus", agent_id: "seosoyoung" })],
      )),
      readNodePreset: vi.fn(() => "claude-opus"),
    });

    await expect(
      resolveExecutionSecurityDecision("s1", "claude-opus", ports),
    ).resolves.toMatchObject({ tier: "restricted", reason: "inherited" });
    expect(ports.readNodePreset).not.toHaveBeenCalled();
  });

  it("restricts when a caller row is missing", async () => {
    const ports = makePorts({
      readSession: vi.fn(async () => chain(
        row({ session_id: "s1", caller_session_id: "missing" }),
      )),
    });

    await expect(
      resolveExecutionSecurityDecision("s1", "claude-opus", ports),
    ).resolves.toMatchObject({ tier: "restricted", reason: "unresolved-ancestry" });
  });

  it("restricts when the caller chain cycles", async () => {
    const ports = makePorts({
      readSession: vi.fn(async () => chain(
        row({ session_id: "s1", caller_session_id: "a" }),
        [row({ session_id: "a", caller_session_id: "a", model_preset: "claude-opus" })],
      )),
    });

    await expect(
      resolveExecutionSecurityDecision("s1", "claude-opus", ports),
    ).resolves.toMatchObject({ tier: "restricted", reason: "unresolved-ancestry" });
  });

  it("restricts when the chain read stops before a remaining caller", async () => {
    const ports = makePorts({
      readSession: vi.fn(async () => chain(
        row({ session_id: "s1", caller_session_id: "a" }),
        [row({ session_id: "a", caller_session_id: "b", model_preset: "claude-opus" })],
      )),
    });

    await expect(
      resolveExecutionSecurityDecision("s1", "claude-opus", ports),
    ).resolves.toMatchObject({ tier: "restricted", reason: "unresolved-ancestry" });
  });

  it("rejects the turn when the caller chain read fails", async () => {
    const cause = new Error("host read failed");
    const ports = makePorts({
      readSession: vi.fn(async () => {
        throw cause;
      }),
    });

    await expect(
      resolveExecutionSecurityDecision("s1", "claude-opus", ports),
    ).rejects.toMatchObject({
      name: "IsolationPolicyUnavailableError",
      code: ISOLATION_POLICY_UNAVAILABLE,
      sessionId: "s1",
      cause,
    });
  });

  it("ignores isolation on Windows without reading the chain", async () => {
    const ports = makePorts({ platform: "win32" });

    await expect(
      resolveExecutionSecurityDecision("s1", "deepseek-flash-4.1", ports),
    ).resolves.toEqual({
      sessionId: "s1",
      tier: "full",
      policyVersion: 1,
      reason: "windows",
      presetId: "deepseek-flash-4.1",
    });
    expect(ports.readSession).not.toHaveBeenCalled();
  });

  it("memoizes preset trust within one decision", async () => {
    const ports = makePorts({
      readSession: vi.fn(async () => chain(
        row({ session_id: "s1", caller_session_id: "a" }),
        [
          row({ session_id: "a", caller_session_id: "b", model_preset: "codex-6.1-sol" }),
          row({ session_id: "b", model_preset: "codex-6.1-sol" }),
        ],
      )),
    });

    await resolveExecutionSecurityDecision("s1", "claude-opus", ports);

    expect(
      ports.isTrustedPreset.mock.calls.filter(([id]) => id === "codex-6.1-sol"),
    ).toHaveLength(1);
  });

  it("restricts when the session row is missing from the chain read", async () => {
    const ports = makePorts({
      readSession: vi.fn(async () => chain(null)),
    });

    await expect(
      resolveExecutionSecurityDecision("s1", "claude-opus", ports),
    ).resolves.toMatchObject({
      tier: "restricted",
      reason: "unresolved-ancestry",
    });
  });

  it("reports the unavailable policy error type", () => {
    const error = new IsolationPolicyUnavailableError("s1", new Error("boom"));

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("ISOLATION_POLICY_UNAVAILABLE");
    expect(error.message).toContain("s1");
  });
});
