import { describe, expect, it } from "vitest";

import type {
  SessionCommand,
  SessionIsolationSpec,
} from "../../src/security/session_isolation_contract.js";
import {
  BWRAP_BASE_FLAGS,
  buildBwrapCommand,
  buildBwrapFlags,
  wrapSessionCommand,
} from "../../src/engine/session_isolation.js";

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
    bindings: [
      { source: "/home/eias/workspace", destination: "/home/eias/workspace", writable: true },
      { source: "/home/eias/.ssh", destination: "/home/eias/.ssh", writable: false },
    ],
    masks: [
      { path: "/home/eias/workspace/.local", kind: "directory" },
      { path: "/home/eias/workspace/.env", kind: "file" },
      { path: "/home/eias/.ssh/id_ed25519", kind: "file" },
    ],
    heavyWorkLockBindings: [
      "/tmp/soulstream-heavy-verify.lock",
      "/tmp/soulstream-heavy-verify.lock.slot-1",
      "/tmp/soulstream-heavy-verify.lock.slot-2",
      "/tmp/soulstream-heavy-verify.lock.slot-3",
    ].map((lockPath) => ({ source: lockPath, destination: lockPath, writable: true })),
    hostProcLocksBinding: { source: "/proc/locks", destination: "/proc/locks", writable: false },
    approvedLocalMcp: [],
    approvedTestDatabase: null,
    ...overrides,
  };
}

const original: SessionCommand = {
  command: "/usr/local/bin/claude",
  args: ["--print", "hello world", "--flag=a b"],
};

function indexOfPair(args: readonly string[], first: string, second: string): number {
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === first && args[index + 1] === second) return index;
  }
  return -1;
}

describe("wrapSessionCommand", () => {
  it("returns the original command and args untouched when isolation is off", () => {
    const result = wrapSessionCommand(original, isolationSpec({ enabled: false }));
    expect(result.command).toBe("/usr/local/bin/claude");
    expect(result.args).toEqual(["--print", "hello world", "--flag=a b"]);
    expect(result.args).toHaveLength(original.args.length);
  });

  it("does not join the argv into a shell string when isolation is off", () => {
    const result = wrapSessionCommand(original, isolationSpec({ enabled: false }));
    expect(result.command).not.toContain(" ");
    expect(result.args).not.toContain("/usr/local/bin/claude --print");
  });

  it("wraps the original argv behind bwrap and a `--` separator", () => {
    const result = wrapSessionCommand(original, isolationSpec());
    expect(result.command).toBe("bwrap");
    expect(result.args.slice(0, BWRAP_BASE_FLAGS.length)).toEqual([...BWRAP_BASE_FLAGS]);
    expect(result.args.slice(-5)).toEqual([
      "--",
      "/usr/local/bin/claude",
      "--print",
      "hello world",
      "--flag=a b",
    ]);
  });

  it("keeps every original argument as its own argv element", () => {
    const result = wrapSessionCommand(
      { command: "codex", args: ["app-server", "--flag", "a b", ""] },
      isolationSpec(),
    );
    const separator = result.args.indexOf("--");
    expect(separator).toBeGreaterThan(-1);
    expect(result.args.slice(separator + 1)).toEqual(["codex", "app-server", "--flag", "a b", ""]);
  });

  it("never adds namespace flags that would detach the CLI from the prepared netns", () => {
    const result = wrapSessionCommand(original, isolationSpec());
    for (const flag of ["--unshare-net", "--unshare-user", "--unshare-all", "--disable-userns", "--as-pid-1"]) {
      expect(result.args).not.toContain(flag);
    }
  });

  it("binds the heavy work lock files read/write and /proc/locks read-only", () => {
    const args = buildBwrapFlags(isolationSpec());
    const lockPaths = [
      "/tmp/soulstream-heavy-verify.lock",
      "/tmp/soulstream-heavy-verify.lock.slot-1",
      "/tmp/soulstream-heavy-verify.lock.slot-2",
      "/tmp/soulstream-heavy-verify.lock.slot-3",
    ];
    expect(lockPaths).toHaveLength(4);
    for (const lockPath of lockPaths) {
      expect(indexOfPair(args, "--bind", lockPath)).toBeGreaterThan(-1);
      expect(args.filter((argument) => argument === lockPath)).toHaveLength(2);
    }
    expect(indexOfPair(args, "--ro-bind", "/proc/locks")).toBeGreaterThan(-1);
    const procIndex = args.indexOf("/proc/locks");
    expect(args[procIndex + 1]).toBe("/proc/locks");
  });

  it("orders parent masks, allowed binds, and final file masks", () => {
    const args = buildBwrapFlags(isolationSpec());
    const directoryMask = indexOfPair(args, "--tmpfs", "/home/eias/workspace/.local");
    const workspaceBind = indexOfPair(args, "--bind", "/home/eias/workspace");
    const fileMask = args.indexOf("/home/eias/workspace/.env");
    const chdir = indexOfPair(args, "--chdir", "/home/eias/workspace");
    expect(directoryMask).toBeGreaterThan(-1);
    expect(directoryMask).toBeLessThan(workspaceBind);
    expect(workspaceBind).toBeLessThan(fileMask);
    expect(fileMask).toBeLessThan(chdir);
  });

  it("masks a directory with a read-only tmpfs and a file with /dev/null", () => {
    const args = buildBwrapFlags(isolationSpec());
    const directoryIndex = indexOfPair(args, "--tmpfs", "/home/eias/workspace/.local");
    expect(args.slice(directoryIndex, directoryIndex + 4)).toEqual([
      "--tmpfs",
      "/home/eias/workspace/.local",
      "--remount-ro",
      "/home/eias/workspace/.local",
    ]);
    const fileIndex = args.indexOf("/home/eias/workspace/.env");
    expect(args.slice(fileIndex - 2, fileIndex + 1)).toEqual([
      "--ro-bind",
      "/dev/null",
      "/home/eias/workspace/.env",
    ]);
  });

  it("changes into the workspace directory before the separator", () => {
    const args = wrapSessionCommand(original, isolationSpec()).args;
    const chdir = args.indexOf("--chdir");
    const separator = args.indexOf("--");
    expect(args[chdir + 1]).toBe("/home/eias/workspace");
    expect(chdir).toBeLessThan(separator);
  });

  it("appends caller-provided mounts after the base and skips duplicates", () => {
    const args = buildBwrapFlags(isolationSpec(), [
      { source: "/run/resolv.conf", destination: "/etc/resolv.conf", writable: false },
      { source: "/elsewhere", destination: "/home/eias/workspace", writable: true },
    ]);
    expect(indexOfPair(args, "--ro-bind", "/run/resolv.conf")).toBeGreaterThan(-1);
    expect(args).not.toContain("/elsewhere");
  });

  it("builds the same argv from an explicit bwrap path", () => {
    const inline = wrapSessionCommand(original, isolationSpec());
    const explicit = buildBwrapCommand("/opt/bwrap", isolationSpec(), original);
    expect(explicit.command).toBe("/opt/bwrap");
    expect(explicit.args).toEqual(inline.args);
  });
});
