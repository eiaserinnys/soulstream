import { describe, expect, it, vi } from "vitest";

import type {
  IsolationLaunchInput,
  SessionIsolationSpec,
} from "../../src/security/session_isolation_contract.js";
import {
  SESSION_ISOLATION_UNAVAILABLE,
  SessionIsolationUnavailableError,
  type IsolationToolchainProbe,
  assertIsolationToolchainReady,
} from "../../src/runner/session_isolation_preflight.js";

function isolationSpec(overrides: Partial<SessionIsolationSpec> = {}): SessionIsolationSpec {
  return {
    version: 1,
    enabled: true,
    sessionId: "s1",
    backend: "claude",
    workspaceDir: "/home/eias/workspace",
    scratchWorkspaceDir: "/home/eias/workspace/.local",
    sandboxDirectory: "/run/soulstream/isolated/s1",
    sessionWorktreeRoot: "/home/eias/workspace/.projects/.isolated",
    authKind: "claude-oauth-token",
    policyDigest: "digest-1",
    bindings: [],
    masks: [],
    heavyWorkLockBindings: [],
    hostProcLocksBinding: { source: "/proc/locks", destination: "/proc/locks", writable: false },
    approvedLocalMcp: [],
    approvedTestDatabase: null,
    ...overrides,
  };
}

function launchInput(overrides: Partial<IsolationLaunchInput> = {}): IsolationLaunchInput {
  return {
    original: { command: "/usr/local/bin/claude", args: ["--print", "hi"] },
    plan: isolationSpec(),
    resolvConfPath: "/run/soulstream/isolated/s1/resolv.conf",
    cwd: "/home/eias/workspace",
    env: { HOME: "/home/eias" },
    stdio: ["pipe", "pipe", "pipe"],
    tools: {
      bwrap: "/usr/bin/bwrap",
      pasta: "/root/usr/bin/pasta",
      unshare: "/usr/bin/unshare",
      setpriv: "/usr/bin/setpriv",
      nft: "/usr/sbin/nft",
      netnsHelper: "/opt/soulstream/session-netns-helper.py",
    },
    ...overrides,
  };
}

function healthyProbe(overrides: Partial<IsolationToolchainProbe> = {}): IsolationToolchainProbe {
  return {
    isExecutableFile: vi.fn(() => true),
    readTextFile: vi.fn((path: string) => {
      if (path.endsWith("/resolv.conf")) return "nameserver 192.0.2.53\n";
      if (path.endsWith("max_user_namespaces")) return "15000\n";
      return null;
    }),
    ...overrides,
  };
}

describe("assertIsolationToolchainReady", () => {
  it("passes when every tool and kernel feature is present", () => {
    const probe = healthyProbe();
    expect(() => assertIsolationToolchainReady(launchInput(), probe)).not.toThrow();
    expect(probe.isExecutableFile).toHaveBeenCalledTimes(6);
  });

  it("fails closed when a required tool is missing or not executable", () => {
    const probe = healthyProbe({
      isExecutableFile: vi.fn((path: string) => path !== "/usr/sbin/nft"),
    });
    expect(() => assertIsolationToolchainReady(launchInput(), probe)).toThrow(
      SessionIsolationUnavailableError,
    );
    try {
      assertIsolationToolchainReady(launchInput(), probe);
    } catch (error) {
      expect((error as SessionIsolationUnavailableError).code).toBe(SESSION_ISOLATION_UNAVAILABLE);
      expect((error as SessionIsolationUnavailableError).detail).toContain("nft");
    }
  });

  it("rejects a relative tool path", () => {
    const input = launchInput({
      tools: { ...launchInput().tools, bwrap: "bwrap" },
    });
    expect(() => assertIsolationToolchainReady(input, healthyProbe())).toThrow(
      /bwrap path is not absolute/,
    );
  });

  it("fails when the session resolv.conf is absent", () => {
    const probe = healthyProbe({
      readTextFile: vi.fn((path: string) => (path.endsWith("/resolv.conf") ? null : "15000\n")),
    });
    expect(() => assertIsolationToolchainReady(launchInput(), probe)).toThrow(
      /sandbox resolv.conf/,
    );
  });

  it("fails when user namespaces are disabled in the kernel", () => {
    const probe = healthyProbe({
      readTextFile: vi.fn((path: string) => {
        if (path.endsWith("/resolv.conf")) return "nameserver 192.0.2.53\n";
        if (path.endsWith("max_user_namespaces")) return "0\n";
        return null;
      }),
    });
    expect(() => assertIsolationToolchainReady(launchInput(), probe)).toThrow(
      /user namespaces are disabled/,
    );
  });

  it("fails when unprivileged user namespaces are switched off", () => {
    const probe = healthyProbe({
      readTextFile: vi.fn((path: string) => {
        if (path.endsWith("/resolv.conf")) return "nameserver 192.0.2.53\n";
        if (path.endsWith("unprivileged_userns_clone")) return "0\n";
        return "15000\n";
      }),
    });
    expect(() => assertIsolationToolchainReady(launchInput(), probe)).toThrow(
      /unprivileged user namespaces are disabled/,
    );
  });

  it("reports every missing piece in one failure", () => {
    const probe = healthyProbe({
      isExecutableFile: vi.fn(() => false),
      readTextFile: vi.fn(() => null),
    });
    try {
      assertIsolationToolchainReady(launchInput(), probe);
      throw new Error("expected a failure");
    } catch (error) {
      const detail = (error as SessionIsolationUnavailableError).detail;
      expect(detail).toContain("bwrap");
      expect(detail).toContain("pasta");
      expect(detail).toContain("netns helper");
      expect(detail).toContain("user namespaces are unavailable");
    }
  });

  it("does not inspect the machine when given a probe", () => {
    const isExecutableFile = vi.fn(() => true);
    const readTextFile = vi.fn(() => "15000\n");
    const probe: IsolationToolchainProbe = {
      isExecutableFile,
      readTextFile: (path: string) => {
        if (path.endsWith("/resolv.conf")) return "nameserver 192.0.2.53\n";
        if (path.endsWith("unprivileged_userns_clone")) return "1\n";
        return readTextFile();
      },
    };
    assertIsolationToolchainReady(launchInput(), probe);
    expect(isExecutableFile).toHaveBeenCalledWith("/usr/bin/bwrap");
  });
});
