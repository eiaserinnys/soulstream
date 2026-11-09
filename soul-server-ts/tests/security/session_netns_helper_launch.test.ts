import { describe, expect, it } from "vitest";

import { launchIsolatedSession } from "../../src/runner/session_netns_helper.js";
import {
  HELPER_PATH,
  UNSHARE_PATH,
  createFakePorts,
  flush,
  isolationSpec,
  launchInput,
  readControlPayload,
  testDependencies,
} from "../helpers/session_isolation_fixtures.js";

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

  it("passes the caller's abort signal to the off-path spawn unchanged", () => {
    const controller = new AbortController();
    const input = launchInput({ plan: isolationSpec({ enabled: false }), signal: controller.signal });
    const fake = createFakePorts();

    launchIsolatedSession(input, fake.ports, testDependencies());

    // 상자 밖 경로는 지금처럼 spawn의 signal로 취소된다.
    expect(fake.spawnCalls[0]?.options.signal).toBe(controller.signal);
  });

  it("leaves the off-path spawn without a signal when the caller gave none", () => {
    const fake = createFakePorts();
    launchIsolatedSession(
      launchInput({ plan: isolationSpec({ enabled: false }) }),
      fake.ports,
      testDependencies(),
    );

    expect(fake.spawnCalls[0]?.options.signal).toBeUndefined();
  });
});

describe("launchIsolatedSession startup sequence", () => {
  it("starts the netns helper with a minimal environment and the control payload", () => {
    const input = launchInput();
    const fake = createFakePorts();

    launchIsolatedSession(input, fake.ports, testDependencies());

    expect(fake.spawnCalls).toHaveLength(1);
    const call = fake.spawnCalls[0];
    expect(call?.command).toBe(UNSHARE_PATH);
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

  it("sends the bwrap path so the helper can wait for its status handshake", () => {
    const fake = createFakePorts();

    launchIsolatedSession(launchInput(), fake.ports, testDependencies());
    const payload = readControlPayload(fake.helper);

    // helper는 이 경로를 argv에서 찾아 `--json-status-fd`를 끼워 넣는다.
    expect(payload.bwrapPath).toBe("/usr/bin/bwrap");
    expect(payload.launch.argv.filter((argument) => argument === payload.bwrapPath))
      .toHaveLength(1);
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
