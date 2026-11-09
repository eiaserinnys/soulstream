import { describe, expect, it } from "vitest";

import { launchIsolatedSession } from "../../src/runner/session_netns_helper.js";
import {
  createFakePorts,
  flush,
  launchInput,
  testDependencies,
} from "../helpers/session_isolation_fixtures.js";

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

  it("tears the box down when pasta exits after ready", async () => {
    const fake = createFakePorts();
    const result = launchIsolatedSession(launchInput(), fake.ports, testDependencies());

    fake.helper.status.write('{"status":"firewall-ready"}\n');
    await flush();
    fake.releaseNetworkReady();
    await expect(result.ready).resolves.toBeUndefined();

    fake.pasta.finish(0, null);
    await flush();

    // pasta는 이미 끝났으므로 helper만 회수된다.
    expect(fake.killCalls).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
    await expect(result.completion).resolves.toEqual({ exitCode: null, signal: "SIGTERM" });
  });
});
