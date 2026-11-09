import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import {
  networkInterfaces as readHostNetworkInterfaces,
  type NetworkInterfaceInfo,
} from "node:os";

import type {
  IsolationLaunchInput,
  IsolationLaunchResult,
  IsolationProcessPorts,
} from "../security/session_isolation_contract.js";
import { buildBwrapCommand } from "../engine/session_isolation.js";

import {
  asIsolationUnavailable,
  assertOwnedProcessId,
  stopImmediately,
  terminateOwnedProcess,
  waitForCompletion,
  withTimeout,
} from "./session_isolation_process.js";
import {
  SessionIsolationUnavailableError,
  assertIsolationToolchainReady,
} from "./session_isolation_preflight.js";
import {
  DEFAULT_NETWORK_READY_TIMEOUT_MS,
  NETNS_HELPER_STATUS_FD,
  awaitNetnsHelperNetworkReady,
  isReadableStream,
  readChildStream,
  statusChannelFor,
} from "./session_netns_helper_status.js";
import {
  buildNftRuleset,
  buildPastaArgv,
  collectHostAddresses,
  computePastaForwardedPorts,
  parseHostIpv4Resolver,
  parseSandboxDnsForwardAddress,
} from "./session_network_policy.js";

export {
  DEFAULT_NETWORK_READY_TIMEOUT_MS,
  NETNS_HELPER_STATUS_FD,
  awaitNetnsHelperNetworkReady,
} from "./session_netns_helper_status.js";
export type {
  NetnsHelperStatus,
  NetnsHelperStatusName,
} from "./session_netns_helper_status.js";

/** netns helper의 제어 입력 fd(`--control-fd 4`). */
export const NETNS_HELPER_CONTROL_FD = 4;

const HOST_RESOLV_CONF_PATH = "/etc/resolv.conf";
/** sandbox 안에서 호스트 `/etc/resolv.conf`를 덮는 경로. */
const SANDBOX_RESOLV_CONF_PATH = "/etc/resolv.conf";

/**
 * host 쪽 보조 프로세스(helper·pasta)에만 주는 최소 환경. 세션 환경은
 * sandbox 자식에게만 제어 채널로 전달한다.
 */
const HOST_HELPER_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
});

export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000;
export const DEFAULT_TERMINATE_GRACE_MS = 2_000;

export interface IsolationLaunchDependencies {
  /** 상자 실행 전 확인. 실패하면 SESSION_ISOLATION_UNAVAILABLE을 던진다. */
  preflight(input: IsolationLaunchInput): void;
  networkInterfaces(): NodeJS.Dict<NetworkInterfaceInfo[]>;
  readTextFile(path: string): string | null;
  /** 이 프로세스가 지금 있는 network namespace의 inode. helper가 자기 것과 비교한다. */
  hostNetnsInode(): number;
  handshakeTimeoutMs: number;
  networkReadyTimeoutMs: number;
  terminateGraceMs: number;
}

export const defaultIsolationLaunchDependencies: IsolationLaunchDependencies = {
  preflight(input: IsolationLaunchInput): void {
    assertIsolationToolchainReady(input);
  },
  networkInterfaces(): NodeJS.Dict<NetworkInterfaceInfo[]> {
    return readHostNetworkInterfaces();
  },
  readTextFile(path: string): string | null {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  hostNetnsInode(): number {
    return statSync("/proc/self/ns/net").ino;
  },
  handshakeTimeoutMs: DEFAULT_HANDSHAKE_TIMEOUT_MS,
  networkReadyTimeoutMs: DEFAULT_NETWORK_READY_TIMEOUT_MS,
  terminateGraceMs: DEFAULT_TERMINATE_GRACE_MS,
};

export function createIsolationProcessPorts(): IsolationProcessPorts {
  return {
    spawn(input) {
      return spawn(input.command, [...input.args], input.options);
    },
    awaitNetworkReady(child) {
      return awaitNetnsHelperNetworkReady(child);
    },
    kill(pid, signal) {
      assertOwnedProcessId(pid, "kill target");
      return process.kill(pid, signal);
    },
  };
}

/**
 * §7의 실행 순서를 그대로 밟는다.
 *
 * 1. 사전 확인 — 하나라도 빠지면 spawn 0으로 SESSION_ISOLATION_UNAVAILABLE
 * 2. `unshare --user --map-current-user --keep-caps --net <helper>`로 상자 생성
 * 3. helper가 netns 안에서 nft를 걸고 `firewall-ready`를 보고
 * 4. host가 pasta를 그 netns에 붙이고 helper가 실제 라우트·주소를 확인해
 *    `network-ready`를 보고
 * 5. helper가 setpriv로 capability를 떨어뜨린 뒤 bwrap으로 CLI 실행
 * 6. `ready`는 위 보고가 실제로 도착했을 때만 완료된다(고정 sleep 없음)
 */
export function launchIsolatedSession(
  input: IsolationLaunchInput,
  ports: IsolationProcessPorts,
  dependencies: IsolationLaunchDependencies = defaultIsolationLaunchDependencies,
): IsolationLaunchResult {
  if (!input.plan.enabled) {
    return launchWithoutIsolation(input, ports, dependencies);
  }

  dependencies.preflight(input);

  const hostResolver = parseHostIpv4Resolver(
    dependencies.readTextFile(HOST_RESOLV_CONF_PATH) ?? "",
  );
  if (hostResolver === null) {
    throw new SessionIsolationUnavailableError(
      `host IPv4 resolver is missing from ${HOST_RESOLV_CONF_PATH}`,
    );
  }
  const sandboxResolvConf = dependencies.readTextFile(input.resolvConfPath);
  const dnsForward4 = sandboxResolvConf === null
    ? null
    : parseSandboxDnsForwardAddress(sandboxResolvConf);
  if (dnsForward4 === null) {
    throw new SessionIsolationUnavailableError(
      `sandbox resolv.conf is not exactly the single forward nameserver line: ${input.resolvConfPath}`,
    );
  }

  const hostAddresses = collectHostAddresses(dependencies.networkInterfaces());
  const nftRuleset = buildNftRuleset({
    host4: hostAddresses.filter((entry) => entry.family === "ipv4").map((entry) => entry.address),
    host6: hostAddresses.filter((entry) => entry.family === "ipv6").map((entry) => entry.address),
    dnsForward4,
    testDatabaseSandboxPort: input.plan.approvedTestDatabase?.sandboxPort ?? null,
  });
  const forwardedPorts = computePastaForwardedPorts(input.plan);

  const bwrapCommand = buildBwrapCommand(input.tools.bwrap, input.plan, input.original, [
    { source: input.resolvConfPath, destination: SANDBOX_RESOLV_CONF_PATH, writable: false },
  ]);
  const launchArgv = [
    input.tools.setpriv,
    "--inh-caps=-all",
    "--ambient-caps=-all",
    "--bounding-set=-all",
    bwrapCommand.command,
    ...bwrapCommand.args,
  ];
  const controlPayload = {
    version: 1,
    nftPath: input.tools.nft,
    nftRuleset,
    hostNetnsInode: dependencies.hostNetnsInode(),
    networkTimeoutMs: dependencies.networkReadyTimeoutMs,
    // helper가 bwrap argv에 `--json-status-fd`를 끼워 넣고, bwrap이 mount를
    // 마치고 자식 pid를 보고할 때까지 `network-ready`를 내지 않는다.
    bwrapPath: input.tools.bwrap,
    launch: { argv: launchArgv, cwd: input.cwd, env: input.env },
  };

  const helperProcess = ports.spawn({
    command: input.tools.unshare,
    args: ["--user", "--map-current-user", "--keep-caps", "--net", input.tools.netnsHelper],
    options: {
      cwd: input.cwd,
      env: { ...HOST_HELPER_ENVIRONMENT },
      stdio: withStatusAndControlStreams(input.stdio),
    },
  });
  helperProcess.on("error", () => undefined);
  const helperPid = assertOwnedProcessId(helperProcess.pid, "netns helper");

  const controlStream = readChildStream(helperProcess, NETNS_HELPER_CONTROL_FD);
  if (!isWritableStream(controlStream)) {
    stopImmediately(ports, helperPid);
    throw new SessionIsolationUnavailableError("netns helper control channel is missing");
  }
  const statusChannel = statusChannelFor(
    helperProcess,
    readChildStream(helperProcess, NETNS_HELPER_STATUS_FD),
  );
  controlStream.on?.("error", () => undefined);
  controlStream.write(`${JSON.stringify(controlPayload)}\n`);
  controlStream.end();

  const terminations = new WeakMap<ChildProcess, Promise<void>>();
  const stopOwned = (child: ChildProcess): Promise<void> => {
    const existing = terminations.get(child);
    if (existing !== undefined) return existing;
    const pending = terminateOwnedProcess(child, ports, dependencies.terminateGraceMs);
    terminations.set(child, pending);
    return pending;
  };

  let pastaProcess: ChildProcess | null = null;
  let pastaDiagnostics = "";
  let disposePromise: Promise<void> | null = null;
  const dispose = (): Promise<void> => {
    disposePromise ??= (async () => {
      if (pastaProcess !== null) await stopOwned(pastaProcess);
      await stopOwned(helperProcess);
    })();
    return disposePromise;
  };

  const completion = waitForCompletion(helperProcess);
  void completion.then(() => {
    if (pastaProcess !== null) void stopOwned(pastaProcess);
  });

  const ready = (async (): Promise<void> => {
    try {
      await statusChannel.wait("firewall-ready", dependencies.handshakeTimeoutMs);
      // buildPastaArgv는 argv[0]에 실행 파일 경로를 넣는다. spawn 포트는
      // command와 args를 따로 받으므로 경로가 인자로 한 번 더 들어가지 않게
      // 나눠 넘긴다. pasta는 첫 위치 인자를 interface 이름으로 읽는다.
      const [pastaCommand, ...pastaArgs] = buildPastaArgv({
        pastaPath: input.tools.pasta,
        namespaceOwnerPid: helperPid,
        forwardedPorts,
        dnsForward4,
        hostResolver,
      });
      const pasta = ports.spawn({
        command: pastaCommand,
        args: pastaArgs,
        options: {
          cwd: input.cwd,
          env: { ...HOST_HELPER_ENVIRONMENT },
          stdio: ["ignore", "ignore", "pipe"],
        },
      });
      pastaProcess = pasta;
      collectDiagnostics(pasta, (text) => {
        pastaDiagnostics = `${pastaDiagnostics}${text}`.slice(-4000);
      });
      // pasta는 상자의 바깥 절반이다. ready 전이든 뒤든 pasta가 끝나거나
      // error를 내면 상자는 성립하지 않거나 이미 반쪽이므로, 기존 dispose
      // 경로 하나로 내린다. ready 전이면 그 거부가 ready를 실패시킨다.
      let rejectPastaStopped: (error: Error) => void = () => undefined;
      const pastaStopped = new Promise<never>((_resolve, reject) => {
        rejectPastaStopped = reject;
      });
      void pastaStopped.catch(() => undefined);
      let pastaStopReported = false;
      const reportPastaStop = (reason: string): void => {
        if (!pastaStopReported) {
          pastaStopReported = true;
          rejectPastaStopped(new SessionIsolationUnavailableError(reason));
        }
        void dispose();
      };
      pasta.on("error", (error: Error) => {
        reportPastaStop(`pasta failed: ${error.message}`);
      });
      pasta.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        reportPastaStop(
          `pasta exited before the session ended (code ${String(code)}, signal ${String(signal)})`,
        );
      });
      await withTimeout(
        Promise.race([ports.awaitNetworkReady(helperProcess), pastaStopped]),
        dependencies.networkReadyTimeoutMs,
        "network readiness",
      );
    } catch (error) {
      await dispose();
      throw asIsolationUnavailable(error, pastaDiagnostics);
    }
  })();
  void ready.catch(() => undefined);

  if (input.signal !== undefined) {
    const signal = input.signal;
    if (signal.aborted) {
      void dispose();
    } else {
      const onAbort = (): void => {
        void dispose();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      // 세션이 끝난 뒤에도 오래 사는 signal에 리스너가 남지 않게 회수한다.
      void completion.then(() => signal.removeEventListener("abort", onAbort));
    }
  }

  return { child: helperProcess, ready, completion, dispose };
}

function launchWithoutIsolation(
  input: IsolationLaunchInput,
  ports: IsolationProcessPorts,
  dependencies: IsolationLaunchDependencies,
): IsolationLaunchResult {
  const child = ports.spawn({
    command: input.original.command,
    args: [...input.original.args],
    // 상자 밖 경로는 지금처럼 spawn에 signal을 그대로 넘겨 취소한다.
    // 상자 안 경로는 helper와 pasta까지 회수해야 하므로 직접 dispose한다.
    options: { cwd: input.cwd, env: input.env, stdio: input.stdio, signal: input.signal },
  });
  child.on("error", () => undefined);
  const completion = waitForCompletion(child);
  let disposePromise: Promise<void> | null = null;
  const dispose = (): Promise<void> => {
    disposePromise ??= terminateOwnedProcess(child, ports, dependencies.terminateGraceMs);
    return disposePromise;
  };
  return { child, ready: Promise.resolve(), completion, dispose };
}

function collectDiagnostics(child: ChildProcess, sink: (text: string) => void): void {
  const stream = readChildStream(child, 2);
  if (!isReadableStream(stream)) return;
  stream.setEncoding?.("utf8");
  stream.on("data", (chunk: string | Buffer) => {
    sink(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  });
  stream.on("error", () => undefined);
}

function withStatusAndControlStreams(stdio: SpawnOptions["stdio"]): SpawnOptions["stdio"] {
  const base: unknown[] = Array.isArray(stdio)
    ? [...stdio]
    : typeof stdio === "string"
      ? [stdio, stdio, stdio]
      : ["pipe", "pipe", "pipe"];
  return [...base, "pipe", "pipe"] as SpawnOptions["stdio"];
}

function isWritableStream(value: unknown): value is NodeJS.WritableStream {
  return typeof value === "object" && value !== null
    && typeof (value as { on?: unknown }).on === "function"
    && typeof (value as { write?: unknown }).write === "function"
    && typeof (value as { end?: unknown }).end === "function";
}
