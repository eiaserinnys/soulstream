import { describe, expect, it, vi } from "vitest";

import { SessionIsolationUnavailableError } from "../../src/runner/session_isolation_preflight.js";
import {
  awaitNetnsHelperNetworkReady,
  launchIsolatedSession,
} from "../../src/runner/session_netns_helper.js";
import {
  UNSHARE_PATH,
  createFakePorts,
  flush,
  launchInput,
  testDependencies,
} from "../helpers/session_isolation_fixtures.js";

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

  it("spawns nothing when the sandbox resolv.conf has a second nameserver line", () => {
    const fake = createFakePorts();
    const dependencies = testDependencies({
      readTextFile: (path: string) => path === "/etc/resolv.conf"
        ? "nameserver 100.100.100.100\n"
        : "nameserver 192.0.2.53\nnameserver 1.1.1.1\n",
    });

    expect(() => launchIsolatedSession(launchInput(), fake.ports, dependencies)).toThrow(
      /not exactly the single forward nameserver line/,
    );
    expect(fake.spawn).not.toHaveBeenCalled();
  });

  it("spawns nothing when the sandbox resolv.conf has extra directives", () => {
    const fake = createFakePorts();
    const dependencies = testDependencies({
      readTextFile: (path: string) => path === "/etc/resolv.conf"
        ? "nameserver 100.100.100.100\n"
        : "search example.test\nnameserver 192.0.2.53\n",
    });

    expect(() => launchIsolatedSession(launchInput(), fake.ports, dependencies)).toThrow(
      SessionIsolationUnavailableError,
    );
    expect(fake.spawn).not.toHaveBeenCalled();
  });

  it("spawns nothing when the sandbox resolv.conf is missing", () => {
    const fake = createFakePorts();
    const dependencies = testDependencies({
      readTextFile: (path: string) => path === "/etc/resolv.conf"
        ? "nameserver 100.100.100.100\n"
        : null,
    });

    expect(() => launchIsolatedSession(launchInput(), fake.ports, dependencies)).toThrow(
      SessionIsolationUnavailableError,
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
        if (input.command === UNSHARE_PATH) return children.helper.asChildProcess();
        throw new Error("pasta is missing");
      },
    });
    const result = launchIsolatedSession(launchInput(), fake.ports, testDependencies());

    fake.helper.status.write('{"status":"firewall-ready"}\n');
    await flush();

    await expect(result.ready).rejects.toThrow(/pasta is missing/);
    expect(fake.killCalls).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  });

  it("rejects `ready` and disposes the box when pasta reports an error before ready", async () => {
    const fake = createFakePorts();
    const result = launchIsolatedSession(launchInput(), fake.ports, testDependencies());

    fake.helper.status.write('{"status":"firewall-ready"}\n');
    await flush();
    fake.pasta.emit("error", new Error("pasta broke"));

    await expect(result.ready).rejects.toThrow(/pasta failed: pasta broke/);
    expect(fake.killCalls.map((entry) => entry.pid)).toEqual([4343, 4242]);
  });

  it("rejects `ready` and disposes the box when pasta exits before ready", async () => {
    const fake = createFakePorts();
    const result = launchIsolatedSession(launchInput(), fake.ports, testDependencies());

    fake.helper.status.write('{"status":"firewall-ready"}\n');
    await flush();
    fake.pasta.finish(1, null);

    await expect(result.ready).rejects.toThrow(/pasta exited before the session ended/);
    // pasta는 이미 끝났으므로 helper만 회수된다.
    expect(fake.killCalls).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  });

  it("rejects a malformed status line instead of guessing", async () => {
    const fake = createFakePorts();
    const result = launchIsolatedSession(launchInput(), fake.ports, testDependencies());

    fake.helper.status.write("not json\n");
    await flush();

    await expect(result.ready).rejects.toThrow(/malformed status line/);
  });

  it("keeps a network-ready report that arrived just before the helper exited", async () => {
    const fake = createFakePorts();
    // 실제 상태 채널로 network-ready를 기다리게 해, 상태 줄과 스트림 end가
    // 같은 tick에 도착하는 경우를 만든다.
    fake.awaitNetworkReady.mockImplementation(
      () => awaitNetnsHelperNetworkReady(fake.helper.asChildProcess(), 1_000),
    );
    const result = launchIsolatedSession(launchInput(), fake.ports, testDependencies());

    fake.helper.status.write('{"status":"firewall-ready"}\n{"status":"network-ready"}\n');
    fake.helper.finish(0, null);

    await expect(result.ready).resolves.toBeUndefined();
  });

  it("rejects a status that never arrived when the helper exited", async () => {
    const fake = createFakePorts();
    const pending = awaitNetnsHelperNetworkReady(fake.helper.asChildProcess(), 1_000);

    fake.helper.finish(1, null);

    await expect(pending).rejects.toThrow(/exited before reporting readiness/);
  });
});
