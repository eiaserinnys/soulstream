import { describe, expect, it } from "vitest";

import { SessionIsolationUnavailableError } from "../../src/runner/session_isolation_preflight.js";
import {
  createIsolationProcessPorts,
  launchIsolatedSession,
} from "../../src/runner/session_netns_helper.js";
import {
  createFakePorts,
  launchInput,
  testDependencies,
} from "../helpers/session_isolation_fixtures.js";

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
