import type { ChildProcess } from "node:child_process";

import { SessionIsolationUnavailableError } from "./session_isolation_preflight.js";

/** netns helper의 상태 보고 fd(`--status-fd 3`). */
export const NETNS_HELPER_STATUS_FD = 3;

export const DEFAULT_NETWORK_READY_TIMEOUT_MS = 30_000;

export type NetnsHelperStatusName = "firewall-ready" | "network-ready" | "error";

export interface NetnsHelperStatus {
  status: NetnsHelperStatusName;
  message?: string;
}

type StatusWaiter = {
  wanted: NetnsHelperStatusName;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/** helper 상태 채널의 줄 단위 JSON을 해석하고, 원하는 상태를 기다린다. */
export class HelperStatusChannel {
  private buffer = "";
  private failure: Error | null = null;
  private readonly received: NetnsHelperStatus[] = [];
  private readonly waiters: StatusWaiter[] = [];

  constructor(stream: unknown) {
    if (!isReadableStream(stream)) {
      this.failure = new SessionIsolationUnavailableError(
        "netns helper status channel is missing",
      );
      return;
    }
    stream.setEncoding?.("utf8");
    stream.on("data", (chunk: string | Buffer) => {
      this.consume(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
    stream.on("end", () => {
      this.fail(new SessionIsolationUnavailableError(
        "netns helper exited before reporting readiness",
      ));
    });
    stream.on("error", () => {
      this.fail(new SessionIsolationUnavailableError("netns helper status channel failed"));
    });
  }

  wait(wanted: NetnsHelperStatusName, timeoutMs: number): Promise<void> {
    // 이미 도착한 상태가 실패보다 먼저다. bwrap이 자식을 보고한 직후 CLI가
    // 바로 끝나면 상태 줄과 스트림 end가 같은 tick에 도착할 수 있는데,
    // 그때 ready를 실패로 뒤집으면 실제로 성립한 상자를 거부하게 된다.
    const index = this.received.findIndex((entry) => entry.status === wanted);
    if (index !== -1) {
      this.received.splice(index, 1);
      return Promise.resolve();
    }
    if (this.failure !== null) return Promise.reject(this.failure);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiterIndex = this.waiters.findIndex((entry) => entry.timer === timer);
        if (waiterIndex !== -1) this.waiters.splice(waiterIndex, 1);
        reject(new SessionIsolationUnavailableError(
          `netns helper did not report ${wanted} within ${timeoutMs}ms`,
        ));
      }, timeoutMs);
      this.waiters.push({ wanted, resolve, reject, timer });
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this.handleLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.fail(new SessionIsolationUnavailableError(
        `netns helper sent a malformed status line: ${line}`,
      ));
      return;
    }
    const message = parsed as Partial<NetnsHelperStatus> | null;
    const status = message?.status;
    if (status === "error") {
      const detail = typeof message?.message === "string" ? message.message : "unknown error";
      this.fail(new SessionIsolationUnavailableError(`netns helper failed: ${detail}`));
      return;
    }
    if (status !== "firewall-ready" && status !== "network-ready") {
      this.fail(new SessionIsolationUnavailableError(
        `netns helper sent an unknown status: ${line}`,
      ));
      return;
    }
    // 실패가 확정된 뒤의 상태 줄은 받지 않는다. 프로토콜이 이미 깨졌으므로
    // 늦게 온 ready가 실패를 뒤집으면 안 된다.
    if (this.failure !== null) return;
    this.received.push({ status });
    const waiterIndex = this.waiters.findIndex((waiter) => waiter.wanted === status);
    const waiter = waiterIndex === -1 ? undefined : this.waiters.splice(waiterIndex, 1)[0];
    if (waiter !== undefined) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private fail(error: Error): void {
    if (this.failure === null) this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(this.failure);
    }
  }
}

const statusChannels = new WeakMap<ChildProcess, HelperStatusChannel>();

export function statusChannelFor(child: ChildProcess, stream: unknown): HelperStatusChannel {
  const existing = statusChannels.get(child);
  if (existing !== undefined) return existing;
  const created = new HelperStatusChannel(stream);
  statusChannels.set(child, created);
  return created;
}

/**
 * helper의 `network-ready` 보고를 기다린다. 상자 실행과 같은 상태 채널을
 * 공유하므로, 대체 어댑터를 끼워 실제 실행을 관찰할 때도 이 함수를 쓴다.
 */
export function awaitNetnsHelperNetworkReady(
  child: ChildProcess,
  timeoutMs: number = DEFAULT_NETWORK_READY_TIMEOUT_MS,
): Promise<void> {
  const channel = statusChannelFor(child, readChildStream(child, NETNS_HELPER_STATUS_FD));
  return channel.wait("network-ready", timeoutMs);
}

export function readChildStream(child: ChildProcess, fd: number): unknown {
  const streams: ReadonlyArray<unknown> | undefined = child.stdio;
  return streams?.[fd];
}

export function isReadableStream(value: unknown): value is NodeJS.ReadableStream {
  return typeof value === "object" && value !== null
    && typeof (value as { on?: unknown }).on === "function"
    && typeof (value as { read?: unknown }).read === "function";
}
