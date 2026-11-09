import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import type { NetworkInterfaceInfo } from "node:os";
import { PassThrough } from "node:stream";

import { expect, vi } from "vitest";

import type {
  IsolationLaunchInput,
  IsolationProcessPorts,
  SessionIsolationSpec,
} from "../../src/security/session_isolation_contract.js";
import type { IsolationLaunchDependencies } from "../../src/runner/session_netns_helper.js";

export const HELPER_PATH = "/opt/soulstream/session-netns-helper.py";
export const UNSHARE_PATH = "/usr/bin/unshare";

export function isolationSpec(overrides: Partial<SessionIsolationSpec> = {}): SessionIsolationSpec {
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
    bindings: [{ source: "/home/eias/workspace", destination: "/home/eias/workspace", writable: true }],
    masks: [{ path: "/home/eias/workspace/.env", kind: "file" }],
    heavyWorkLockBindings: ["/tmp/soulstream-heavy-verify.lock"].map((lockPath) => ({
      source: lockPath,
      destination: lockPath,
      writable: true,
    })),
    hostProcLocksBinding: { source: "/proc/locks", destination: "/proc/locks", writable: false },
    approvedLocalMcp: [{ serverId: "serendipity", hostPort: 4002, sandboxPort: 14002 }],
    approvedTestDatabase: { hostPort: 5434, sandboxPort: 15432 },
    ...overrides,
  };
}

export function launchInput(overrides: Partial<IsolationLaunchInput> = {}): IsolationLaunchInput {
  return {
    original: { command: "/usr/local/bin/claude", args: ["--print", "hello"] },
    plan: isolationSpec(),
    resolvConfPath: "/run/soulstream/isolated/s1/resolv.conf",
    cwd: "/home/eias/workspace",
    env: { HOME: "/home/eias", SOULSTREAM_SECRET: "not-for-the-helper" },
    stdio: ["pipe", "pipe", "pipe"],
    tools: {
      bwrap: "/usr/bin/bwrap",
      pasta: "/root/usr/bin/pasta",
      unshare: UNSHARE_PATH,
      setpriv: "/usr/bin/setpriv",
      nft: "/usr/sbin/nft",
      netnsHelper: HELPER_PATH,
    },
    ...overrides,
  };
}

export function interfaceEntry(address: string, family: string): NetworkInterfaceInfo {
  return {
    address,
    netmask: family === "IPv4" ? "255.255.255.0" : "ffff:ffff:ffff:ffff::",
    family,
    mac: "00:00:00:00:00:00",
    internal: false,
    cidr: family === "IPv4" ? `${address}/24` : `${address}/64`,
  };
}

export function testDependencies(
  overrides: Partial<IsolationLaunchDependencies> = {},
): IsolationLaunchDependencies {
  return {
    preflight: vi.fn(),
    networkInterfaces: () => ({
      eth0: [interfaceEntry("203.0.113.9", "IPv4"), interfaceEntry("2001:db8::5", "IPv6")],
      lo: [interfaceEntry("127.0.0.1", "IPv4")],
    }),
    readTextFile: (path: string) => {
      if (path === "/etc/resolv.conf") return "nameserver 100.100.100.100\n";
      if (path === "/run/soulstream/isolated/s1/resolv.conf") return "nameserver 192.0.2.53\n";
      return null;
    },
    hostNetnsInode: () => 4026532499,
    handshakeTimeoutMs: 2_000,
    networkReadyTimeoutMs: 2_000,
    terminateGraceMs: 20,
    ...overrides,
  };
}

export class FakeChildProcess extends EventEmitter {
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdio: Array<PassThrough | null>;

  constructor(pid: unknown) {
    super();
    this.pid = pid as number | undefined;
    this.stdio = [null, null, null, new PassThrough(), new PassThrough()];
  }

  get status(): PassThrough {
    return this.stdio[3] as PassThrough;
  }

  get control(): PassThrough {
    return this.stdio[4] as PassThrough;
  }

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.status.end();
    this.emit("exit", code, signal);
  }

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

export interface SpawnCall {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
}

export interface FakePortsOptions {
  helperPid?: unknown;
  pastaPid?: unknown;
  exitOnSignal?: boolean;
  networkReady?: () => Promise<void>;
  spawnImpl?: (
    input: SpawnCall,
    children: { helper: FakeChildProcess; pasta: FakeChildProcess },
  ) => ChildProcess;
}

export function createFakePorts(options: FakePortsOptions = {}) {
  const helper = new FakeChildProcess("helperPid" in options ? options.helperPid : 4242);
  const pasta = new FakeChildProcess("pastaPid" in options ? options.pastaPid : 4343);
  const spawnCalls: SpawnCall[] = [];
  const killCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const exitOnSignal = options.exitOnSignal ?? true;
  let releaseNetworkReady: () => void = () => undefined;
  const networkReadyGate = new Promise<void>((resolve) => {
    releaseNetworkReady = resolve;
  });

  const spawn = vi.fn((input: SpawnCall): ChildProcess => {
    spawnCalls.push(input);
    if (options.spawnImpl !== undefined) return options.spawnImpl(input, { helper, pasta });
    const isPasta = input.command === "/root/usr/bin/pasta";
    return isPasta ? pasta.asChildProcess() : helper.asChildProcess();
  });
  const kill = vi.fn((pid: number, signal: NodeJS.Signals): boolean => {
    killCalls.push({ pid, signal });
    if (exitOnSignal && signal === "SIGTERM") {
      queueMicrotask(() => {
        if (pid === helper.pid) helper.finish(null, "SIGTERM");
        else if (pid === pasta.pid) pasta.finish(null, "SIGTERM");
      });
    }
    return true;
  });
  const awaitNetworkReady = vi.fn(
    options.networkReady === undefined
      ? (): Promise<void> => networkReadyGate
      : options.networkReady,
  );
  const ports: IsolationProcessPorts = { spawn, awaitNetworkReady, kill };
  return {
    ports,
    helper,
    pasta,
    spawn,
    kill,
    spawnCalls,
    killCalls,
    awaitNetworkReady,
    releaseNetworkReady: () => releaseNetworkReady(),
  };
}

export function drain(stream: PassThrough): string {
  const chunks: Buffer[] = [];
  let chunk = stream.read() as Buffer | null;
  while (chunk !== null) {
    chunks.push(chunk);
    chunk = stream.read() as Buffer | null;
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface LaunchControlPayload {
  version: number;
  nftPath: string;
  nftRuleset: string;
  hostNetnsInode: number;
  networkTimeoutMs: number;
  bwrapPath: string;
  launch: { argv: string[]; cwd: string; env: Record<string, string> };
}

export function readControlPayload(child: FakeChildProcess): LaunchControlPayload {
  const text = drain(child.control);
  expect(text.endsWith("\n")).toBe(true);
  return JSON.parse(text) as LaunchControlPayload;
}

export const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
