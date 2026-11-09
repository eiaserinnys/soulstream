import { spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import type { NetworkInterfaceInfo } from "node:os";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type {
  IsolationLaunchInput,
  IsolationProcessPorts,
  SessionIsolationSpec,
} from "../../src/security/session_isolation_contract.js";
import {
  SessionIsolationUnavailableError,
} from "../../src/runner/session_isolation_preflight.js";
import {
  createIsolationProcessPorts,
  launchIsolatedSession,
  type IsolationLaunchDependencies,
} from "../../src/runner/session_netns_helper.js";

const HELPER_PATH = "/opt/soulstream/session-netns-helper.py";
const UNshare_PATH = "/usr/bin/unshare";

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

function launchInput(overrides: Partial<IsolationLaunchInput> = {}): IsolationLaunchInput {
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
      unshare: UNshare_PATH,
      setpriv: "/usr/bin/setpriv",
      nft: "/usr/sbin/nft",
      netnsHelper: HELPER_PATH,
    },
    ...overrides,
  };
}

function interfaceEntry(address: string, family: string): NetworkInterfaceInfo {
  return {
    address,
    netmask: family === "IPv4" ? "255.255.255.0" : "ffff:ffff:ffff:ffff::",
    family,
    mac: "00:00:00:00:00:00",
    internal: false,
    cidr: family === "IPv4" ? `${address}/24` : `${address}/64`,
  };
}

function testDependencies(
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

class FakeChildProcess extends EventEmitter {
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

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
}

interface FakePortsOptions {
  helperPid?: unknown;
  pastaPid?: unknown;
  exitOnSignal?: boolean;
  networkReady?: () => Promise<void>;
  spawnImpl?: (
    input: SpawnCall,
    children: { helper: FakeChildProcess; pasta: FakeChildProcess },
  ) => ChildProcess;
}

function createFakePorts(options: FakePortsOptions = {}) {
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

function drain(stream: PassThrough): string {
  const chunks: Buffer[] = [];
  let chunk = stream.read() as Buffer | null;
  while (chunk !== null) {
    chunks.push(chunk);
    chunk = stream.read() as Buffer | null;
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface LaunchControlPayload {
  version: number;
  nftPath: string;
  nftRuleset: string;
  hostNetnsInode: number;
  networkTimeoutMs: number;
  launch: { argv: string[]; cwd: string; env: Record<string, string> };
}

function readControlPayload(child: FakeChildProcess): LaunchControlPayload {
  const text = drain(child.control);
  expect(text.endsWith("\n")).toBe(true);
  return JSON.parse(text) as LaunchControlPayload;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("launchIsolatedSession with isolation disabled", () => {
  it("spawns the original command and never runs the isolation preflight", async () => {
    const input = launchInput({ plan: isolationSpec({ enabled: false }) });
    const dependencies = testDependencies();
    const fake = createFakePorts();

    const result = launchIsolatedSession(input, fake.ports, dependencies);

    expect(dependencies.preflight).not.toHaveBeenCalled();
    expect(fake.spawn).toHaveBeenCalledTimes(1);
    expect(fake.spawnCalls[0]?.command).toBe("/usr/local/bin/claude");
    expect(fake.spawnCalls[0]?.args).toEqual(["--print", "hello"]);
    expect(fake.spawnCalls[0]?.options.env).toEqual(input.env);
    await expect(result.ready).resolves.toBeUndefined();
    expect(fake.helper.status.listenerCount("data")).toBe(0);
  });

  it("disposes only the process it spawned", async () => {
    const input = launchInput({ plan: isolationSpec({ enabled: false }) });
    const fake = createFakePorts();
    const result = launchIsolatedSession(input, fake.ports, testDependencies());

    await result.dispose();

    expect(fake.killCalls).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  });
});

describe("launchIsolatedSession startup sequence", () => {
  it("starts the netns helper with a minimal environment and the control payload", () => {
    const input = launchInput();
    const fake = createFakePorts();

    launchIsolatedSession(input, fake.ports, testDependencies());

    expect(fake.spawnCalls).toHaveLength(1);
    const call = fake.spawnCalls[0];
    expect(call?.command).toBe(UNshare_PATH);
    expect(call?.args).toEqual([
      "--user",
      "--map-current-user",
      "--keep-caps",
      "--net",
      HELPER_PATH,
    ]);
    expect(call?.options.env).toEqual({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
    expect(call?.options.env).not.toHaveProperty("SOULSTREAM_SECRET");
    expect(call?.options.stdio).toHaveLength(5);
    expect((call?.options.stdio as unknown[]).slice(3)).toEqual(["pipe", "pipe"]);
  });

  it("sends the nft ruleset, bwrap argv, cwd, and the session env over the control channel", () => {
    const input = launchInput();
    const fake = createFakePorts();

    launchIsolatedSession(input, fake.ports, testDependencies());
    const payload = readControlPayload(fake.helper);

    expect(payload.version).toBe(1);
    expect(payload.nftPath).toBe("/usr/sbin/nft");
    expect(payload.nftRuleset).toContain("table inet soulstream_isolation {");
    expect(payload.nftRuleset).toContain("elements = { 203.0.113.9 };");
    expect(payload.nftRuleset).toContain("elements = { 2001:db8::5 };");
    expect(payload.nftRuleset).toContain("set testdb_ports { type inet_service; elements = { 15432 }; }");
    expect(payload.hostNetnsInode).toBe(4026532499);
    expect(payload.launch.cwd).toBe("/home/eias/workspace");
    expect(payload.launch.env).toEqual(input.env);

    const argv = payload.launch.argv;
    expect(argv[0]).toBe("/usr/bin/setpriv");
    expect(argv.slice(1, 4)).toEqual([
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--bounding-set=-all",
    ]);
    expect(argv[4]).toBe("/usr/bin/bwrap");
    const separator = argv.indexOf("--");
    expect(separator).toBeGreaterThan(-1);
    expect(argv.slice(separator + 1)).toEqual(["/usr/local/bin/claude", "--print", "hello"]);
    const resolv = argv.indexOf("/run/soulstream/isolated/s1/resolv.conf");
    expect(resolv).toBeGreaterThan(-1);
    expect(argv[resolv + 1]).toBe("/etc/resolv.conf");
  });

  it("does not attach pasta until the helper reports the firewall is ready", async () => {
    const fake = createFakePorts();
    const result = launchIsolatedSession(launchInput(), fake.ports, testDependencies());

    expect(fake.spawnCalls).toHaveLength(1);
    fake.helper.status.write('{"status":"firewall-ready"}\n');
    await flush();

    expect(fake.spawnCalls).toHaveLength(2);
    expect(fake.spawnCalls[1]?.command).toBe("/root/usr/bin/pasta");
    // pasta는 argv[1]을 interface 이름으로 읽는다. 실행 파일 경로가 인자로 한 번
    // 더 들어가면 붙지 못하고 local mode로 떨어진다(261109 실측).
    expect(fake.spawnCalls[1]?.args.filter((arg) => arg === "/root/usr/bin/pasta")).toEqual([]);
    expect(fake.spawnCalls[1]?.args).toEqual([
      "-f",
      "--config-net",
      "--no-map-gw",
      "-t",
      "none",
      "-u",
      "none",
      "-U",
      "none",
      "-T",
      "14002:4002,15432:5434",
      "--dns-forward",
      "192.0.2.53",
      "--dns-host",
      "100.100.100.100",
      "--userns",
      "/proc/4242/ns/user",
      "--netns",
      "/proc/4242/ns/net",
    ]);
    expect(fake.spawnCalls[1]?.options.env).toEqual({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });

    fake.releaseNetworkReady();
    await expect(result.ready).resolves.toBeUndefined();
  });

  it("keeps `ready` pending until the injected readiness port settles", async () => {
    const fake = createFakePorts();
    const result = launchIsolatedSession(launchInput(), fake.ports, testDependencies());
    let settled = false;
    void result.ready.then(() => {
      settled = true;
    });

    fake.helper.status.write('{"status":"firewall-ready"}\n');
    await flush();
    await flush();
    expect(settled).toBe(false);

    fake.releaseNetworkReady();
    await expect(result.ready).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });
});

describe("launchIsolatedSession fail-closed paths", () => {
  it("spawns nothing when the preflight fails", () => {
    const fake = createFakePorts();
    const dependencies = testDependencies({
      preflight: vi.fn(() => {
        throw new SessionIsolationUnavailableError("bwrap is missing");
      }),
    });

    expect(() => launchIsolatedSession(launchInput(), fake.ports, dependencies)).toThrow(
      SessionIsolationUnavailableError,
    );
    expect(fake.spawn).not.toHaveBeenCalled();
  });

  it("spawns nothing when the host has no IPv4 resolver", () => {
    const fake = createFakePorts();
    const dependencies = testDependencies({
      readTextFile: () => null,
    });

    expect(() => launchIsolatedSession(launchInput(), fake.ports, dependencies)).toThrow(
      /host IPv4 resolver/,
    );
    expect(fake.spawn).not.toHaveBeenCalled();
  });

  it("rejects `ready` and disposes the helper when it reports an error", async () => {
    const fake = createFakePorts();
    const result = launchIsolatedSession(launchInput(), fake.ports, testDependencies());

    fake.helper.status.write('{"status":"error","message":"nft failed"}\n');
    await flush();

    await expect(result.ready).rejects.toThrow(/nft failed/);
    expect(fake.killCalls).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  });

  it("rejects `ready` when the helper exits before reporting readiness", async () => {
    const fake = createFakePorts();
    const result = launchIsolatedSession(launchInput(), fake.ports, testDependencies());

    fake.helper.finish(1, null);
    await flush();

    await expect(result.ready).rejects.toThrow(/exited before reporting readiness/);
    expect(fake.killCalls).toEqual([]);
    await expect(result.completion).resolves.toEqual({ exitCode: 1, signal: null });
  });

  it("rejects `ready` when the firewall handshake times out", async () => {
    const fake = createFakePorts();
    const result = launchIsolatedSession(
      launchInput(),
      fake.ports,
      testDependencies({ handshakeTimeoutMs: 15 }),
    );

    await expect(result.ready).rejects.toThrow(/did not report firewall-ready/);
    expect(fake.spawnCalls).toHaveLength(1);
    expect(fake.killCalls).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  });

  it("rejects `ready` when network readiness never arrives", async () => {
    const fake = createFakePorts({ networkReady: () => new Promise<void>(() => undefined) });
    const result = launchIsolatedSession(
      launchInput(),
      fake.ports,
      testDependencies({ networkReadyTimeoutMs: 15 }),
    );

    fake.helper.status.write('{"status":"firewall-ready"}\n');
    await expect(result.ready).rejects.toThrow(/network readiness timed out/);
    expect(fake.killCalls.map((entry) => entry.pid)).toEqual([4343, 4242]);
  });

  it("rejects `ready` and disposes the helper when pasta cannot start", async () => {
    const fake = createFakePorts({
      spawnImpl: (input, children) => {
        if (input.command === UNshare_PATH) return children.helper.asChildProcess();
        throw new Error("pasta is missing");
      },
    });
    const result = launchIsolatedSession(launchInput(), fake.ports, testDependencies());

    fake.helper.status.write('{"status":"firewall-ready"}\n');
    await flush();

    await expect(result.ready).rejects.toThrow(/pasta is missing/);
    expect(fake.killCalls).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  });

  it("rejects a malformed status line instead of guessing", async () => {
    const fake = createFakePorts();
    const result = launchIsolatedSession(launchInput(), fake.ports, testDependencies());

    fake.helper.status.write("not json\n");
    await flush();

    await expect(result.ready).rejects.toThrow(/malformed status line/);
  });
});

describe("launchIsolatedSession ownership and teardown", () => {
  it("sends SIGTERM to pasta and the helper, then SIGKILL when they do not exit", async () => {
    const fake = createFakePorts({ exitOnSignal: false });
    const result = launchIsolatedSession(
      launchInput(),
      fake.ports,
      testDependencies({ terminateGraceMs: 10 }),
    );

    fake.helper.status.write('{"status":"firewall-ready"}\n');
    await flush();
    await result.dispose();

    expect(fake.killCalls).toEqual([
      { pid: 4343, signal: "SIGTERM" },
      { pid: 4343, signal: "SIGKILL" },
      { pid: 4242, signal: "SIGTERM" },
      { pid: 4242, signal: "SIGKILL" },
    ]);
  });

  it("memoizes dispose so repeated calls signal each owned process once", async () => {
    const fake = createFakePorts();
    const result = launchIsolatedSession(launchInput(), fake.ports, testDependencies());

    await Promise.all([result.dispose(), result.dispose(), result.dispose()]);

    expect(fake.killCalls).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  });

  it("disposes owned processes when the abort signal fires", async () => {
    const controller = new AbortController();
    const fake = createFakePorts();
    const input = launchInput({ signal: controller.signal });
    const result = launchIsolatedSession(input, fake.ports, testDependencies());

    controller.abort();
    await expect(result.ready).rejects.toThrow();
    await result.dispose();

    expect(fake.killCalls).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  });

  it("disposes immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = createFakePorts();
    const result = launchIsolatedSession(
      launchInput({ signal: controller.signal }),
      fake.ports,
      testDependencies(),
    );

    await expect(result.ready).rejects.toThrow();
    await result.dispose();

    expect(fake.killCalls).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  });

  it("stops pasta when the helper exits on its own", async () => {
    const fake = createFakePorts();
    const result = launchIsolatedSession(launchInput(), fake.ports, testDependencies());

    fake.helper.status.write('{"status":"firewall-ready"}\n');
    await flush();
    fake.releaseNetworkReady();
    await expect(result.ready).resolves.toBeUndefined();

    fake.helper.finish(0, null);
    await expect(result.completion).resolves.toEqual({ exitCode: 0, signal: null });
    await flush();

    expect(fake.killCalls).toEqual([{ pid: 4343, signal: "SIGTERM" }]);
  });
});

describe("pid ownership guard (#1102 regression)", () => {
  it("never forwards an unverified pid to the kill port", () => {
    const invalidPids: unknown[] = [
      1,
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "4242",
      {},
      null,
      undefined,
    ];
    for (const pid of invalidPids) {
      const fake = createFakePorts({ helperPid: pid });
      expect(() => launchIsolatedSession(launchInput(), fake.ports, testDependencies())).toThrow(
        SessionIsolationUnavailableError,
      );
      expect(fake.kill).not.toHaveBeenCalled();
    }
  });

  it("only ever passes the verified helper pid to the kill port", async () => {
    const fake = createFakePorts({ helperPid: 987654 });
    const result = launchIsolatedSession(launchInput(), fake.ports, testDependencies());

    await result.dispose();

    expect(fake.killCalls).toEqual([{ pid: 987654, signal: "SIGTERM" }]);
  });

  it("refuses non-integer pids inside the real kill adapter before signaling", () => {
    const { kill } = createIsolationProcessPorts();
    const invalidPids: unknown[] = [
      0,
      1,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "4242",
      {},
      null,
      undefined,
    ];
    for (const pid of invalidPids) {
      expect(() => kill(pid as number, "SIGTERM")).toThrow(SessionIsolationUnavailableError);
    }
  });
});

const helperScriptPath = fileURLToPath(
  new URL("../../scripts/session-netns-helper.py", import.meta.url),
);
const python3Available = spawnSync("python3", ["-c", "print(1)"], {
  encoding: "utf8",
  timeout: 20_000,
}).status === 0;

describe.skipIf(!python3Available)("session-netns-helper.py", () => {
  it("compiles under python3", () => {
    const compiled = spawnSync(
      "python3",
      ["-c", "import sys; compile(open(sys.argv[1]).read(), sys.argv[1], 'exec')", helperScriptPath],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(compiled.stderr).toBe("");
    expect(compiled.status).toBe(0);
  });
});
