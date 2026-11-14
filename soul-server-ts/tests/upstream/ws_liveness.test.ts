import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import {
  DEFAULT_WS_PING_INTERVAL_MS,
  DEFAULT_WS_PING_MISS_LIMIT,
  attachWsLiveness,
} from "../../src/upstream/ws_liveness.js";

type Listener = (...args: unknown[]) => void;

class FakeSocket {
  readyState = WebSocket.OPEN;
  pingCount = 0;
  terminated = false;
  private readonly listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener): this {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }

  once(event: string, listener: Listener): this {
    const wrapper: Listener = (...args) => {
      this.off(event, wrapper);
      listener(...args);
    };
    return this.on(event, wrapper);
  }

  off(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  ping(): void {
    this.pingCount += 1;
  }

  terminate(): void {
    this.terminated = true;
    this.emit("close");
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener(...args);
    }
  }
}

function asWs(socket: FakeSocket): WebSocket {
  return socket as unknown as WebSocket;
}

describe("attachWsLiveness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("기본값은 15초 간격과 2회 놓침", () => {
    expect(DEFAULT_WS_PING_INTERVAL_MS).toBe(15_000);
    expect(DEFAULT_WS_PING_MISS_LIMIT).toBe(2);
  });

  it("pong이 없으면 놓침 한도 뒤 terminate하고 타이머를 멈춘다", async () => {
    const socket = new FakeSocket();
    attachWsLiveness(asWs(socket), { intervalMs: 10, missLimit: 2 });

    await vi.advanceTimersByTimeAsync(20);
    expect(socket.terminated).toBe(false);
    expect(socket.pingCount).toBe(2);

    await vi.advanceTimersByTimeAsync(10);
    expect(socket.terminated).toBe(true);

    await vi.advanceTimersByTimeAsync(100);
    expect(socket.pingCount).toBe(2);
  });

  it("pong이 오는 동안에는 유지된다", async () => {
    const socket = new FakeSocket();
    attachWsLiveness(asWs(socket), { intervalMs: 10, missLimit: 2 });

    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(10);
      socket.emit("pong");
    }

    expect(socket.terminated).toBe(false);
    expect(socket.pingCount).toBe(20);
  });

  it("close 이벤트가 타이머를 지운다", async () => {
    const socket = new FakeSocket();
    attachWsLiveness(asWs(socket), { intervalMs: 10, missLimit: 2 });

    await vi.advanceTimersByTimeAsync(10);
    expect(socket.pingCount).toBe(1);

    socket.emit("close");
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.pingCount).toBe(1);
    expect(socket.terminated).toBe(false);
  });
});
