import type { NetworkInterfaceInfo } from "node:os";

import { describe, expect, it } from "vitest";

import type { SessionIsolationSpec } from "../../src/security/session_isolation_contract.js";
import { SessionIsolationUnavailableError } from "../../src/runner/session_isolation_preflight.js";
import {
  ISOLATION_DNS_FORWARD_ADDRESS,
  buildNftRuleset,
  buildPastaArgv,
  buildSessionResolvConf,
  collectHostAddresses,
  computePastaForwardedPorts,
  isIpv4Literal,
  parseHostIpv4Resolver,
  parseSandboxDnsForwardAddress,
} from "../../src/runner/session_network_policy.js";

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
    bindings: [],
    masks: [],
    heavyWorkLockBindings: [],
    hostProcLocksBinding: { source: "/proc/locks", destination: "/proc/locks", writable: false },
    approvedLocalMcp: [],
    approvedTestDatabase: null,
    ...overrides,
  };
}

function interfaceEntry(
  address: string,
  family: string,
  internal: boolean,
): NetworkInterfaceInfo {
  return {
    address,
    netmask: family === "IPv4" ? "255.255.255.0" : "ffff:ffff:ffff:ffff::",
    family,
    mac: "00:00:00:00:00:00",
    internal,
    cidr: family === "IPv4" ? `${address}/24` : `${address}/64`,
  };
}

describe("sandbox resolv.conf", () => {
  it("contains exactly the single nameserver line", () => {
    expect(buildSessionResolvConf()).toBe("nameserver 192.0.2.53\n");
    expect(ISOLATION_DNS_FORWARD_ADDRESS).toBe("192.0.2.53");
  });

  it("reads the forward address back from the generated file", () => {
    expect(parseSandboxDnsForwardAddress(buildSessionResolvConf())).toBe("192.0.2.53");
  });
});

describe("host address collection", () => {
  it("keeps non-loopback addresses, drops internal and loopback entries", () => {
    const addresses = collectHostAddresses({
      lo: [interfaceEntry("127.0.0.1", "IPv4", true), interfaceEntry("::1", "IPv6", true)],
      eth0: [
        interfaceEntry("203.0.113.9", "IPv4", false),
        interfaceEntry("2001:db8::5", "IPv6", false),
      ],
      tun0: [interfaceEntry("10.8.0.2", "IPv4", false)],
    });
    expect(addresses).toEqual([
      { address: "10.8.0.2", family: "ipv4" },
      { address: "203.0.113.9", family: "ipv4" },
      { address: "2001:db8::5", family: "ipv6" },
    ]);
  });

  it("strips the IPv6 scope suffix and de-duplicates addresses", () => {
    const addresses = collectHostAddresses({
      eth0: [
        interfaceEntry("fe80::1%eth0", "IPv6", false),
        interfaceEntry("fe80::1", "IPv6", false),
      ],
      eth1: [interfaceEntry("203.0.113.9", "IPv4", false)],
      eth2: [interfaceEntry("203.0.113.9", "IPv4", false)],
    });
    expect(addresses).toEqual([
      { address: "203.0.113.9", family: "ipv4" },
      { address: "fe80::1", family: "ipv6" },
    ]);
  });

  it("ignores interfaces that report an unknown family", () => {
    const addresses = collectHostAddresses({
      eth0: [interfaceEntry("203.0.113.9", "IPv4", false)],
      eth1: [interfaceEntry("2001:db8::5", "unknown", false)],
    });
    expect(addresses).toEqual([{ address: "203.0.113.9", family: "ipv4" }]);
  });
});

describe("resolver parsing", () => {
  it("picks the first IPv4 nameserver and skips IPv6 entries", () => {
    const text = [
      "# generated",
      "nameserver 2001:db8::53",
      "nameserver 100.100.100.100",
      "search example.test",
      "nameserver 1.1.1.1",
    ].join("\n");
    expect(parseHostIpv4Resolver(text)).toBe("100.100.100.100");
  });

  it("returns null when no IPv4 nameserver exists", () => {
    expect(parseHostIpv4Resolver("nameserver 2001:db8::53\n")).toBeNull();
    expect(parseHostIpv4Resolver("")).toBeNull();
  });
});

describe("pasta forwarded port set", () => {
  it("maps each approved sandbox port to the host port the server listens on", () => {
    const spec = isolationSpec({
      approvedLocalMcp: [
        { serverId: "serendipity", hostPort: 4002, sandboxPort: 14002 },
        { serverId: "atom", hostPort: 4200, sandboxPort: 14200 },
        { serverId: "other", hostPort: 4002, sandboxPort: 14002 },
      ],
      approvedTestDatabase: { hostPort: 5434, sandboxPort: 15432 },
    });
    expect(computePastaForwardedPorts(spec)).toEqual([
      "14002:4002",
      "14200:4200",
      "15432:5434",
    ]);
  });

  it("does not translate when the sandbox and host ports are equal", () => {
    const spec = isolationSpec({
      approvedLocalMcp: [{ serverId: "soulstream", hostPort: 3115, sandboxPort: 3115 }],
      approvedTestDatabase: null,
    });
    expect(computePastaForwardedPorts(spec)).toEqual(["3115"]);
  });

  it("never forwards the host port when no sandbox port is approved", () => {
    const spec = isolationSpec({ approvedTestDatabase: { hostPort: 5434, sandboxPort: 15432 } });
    expect(computePastaForwardedPorts(spec)).toEqual(["15432:5434"]);
  });

  it("rejects an out-of-range port", () => {
    const spec = isolationSpec({
      approvedTestDatabase: { hostPort: 5434, sandboxPort: 70000 },
    });
    expect(() => computePastaForwardedPorts(spec)).toThrow(SessionIsolationUnavailableError);
  });
});

describe("pasta argv", () => {
  it("matches the fixed argument list and the exact forwarded port list", () => {
    const argv = buildPastaArgv({
      pastaPath: "/usr/local/bin/pasta",
      namespaceOwnerPid: 4242,
      forwardedPorts: ["14002:4002", "15432:5434"],
      dnsForward4: "192.0.2.53",
      hostResolver: "100.100.100.100",
    });
    expect(argv).toEqual([
      "/usr/local/bin/pasta",
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
  });

  it("uses `none` when the session has no approved sandbox port", () => {
    const argv = buildPastaArgv({
      pastaPath: "/usr/local/bin/pasta",
      namespaceOwnerPid: 4242,
      forwardedPorts: [],
      dnsForward4: "192.0.2.53",
      hostResolver: "100.100.100.100",
    });
    const targetIndex = argv.indexOf("-T");
    expect(argv[targetIndex + 1]).toBe("none");
  });

  it("never enables automatic forwarding or host loopback mapping", () => {
    const argv = buildPastaArgv({
      pastaPath: "/usr/local/bin/pasta",
      namespaceOwnerPid: 4242,
      forwardedPorts: ["14002:4002"],
      dnsForward4: "192.0.2.53",
      hostResolver: "100.100.100.100",
    });
    for (const flag of ["--map-host-loopback", "--map-guest-addr"]) {
      expect(argv).not.toContain(flag);
    }
    for (const flag of ["-t", "-u", "-U"]) {
      const index = argv.indexOf(flag);
      expect(index).toBeGreaterThan(-1);
      expect(argv[index + 1]).toBe("none");
    }
  });

  it("refuses a pid that is not a positive integer", () => {
    for (const pid of [1, 0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => buildPastaArgv({
        pastaPath: "/usr/local/bin/pasta",
        namespaceOwnerPid: pid,
        forwardedPorts: [],
        dnsForward4: "192.0.2.53",
        hostResolver: "100.100.100.100",
      })).toThrow(SessionIsolationUnavailableError);
    }
  });

  it("refuses a non-IPv4 resolver", () => {
    expect(() => buildPastaArgv({
      pastaPath: "/usr/local/bin/pasta",
      namespaceOwnerPid: 4242,
      forwardedPorts: [],
      dnsForward4: "192.0.2.53",
      hostResolver: "2001:db8::53",
    })).toThrow(SessionIsolationUnavailableError);
  });
});

describe("nft ruleset", () => {
  it("renders the fixed ruleset with literal host addresses and the test DB port", () => {
    const ruleset = buildNftRuleset({
      host4: ["203.0.113.9"],
      host6: ["2001:db8::5"],
      dnsForward4: "192.0.2.53",
      testDatabaseSandboxPort: 15432,
    });
    expect(ruleset).toBe(`table inet soulstream_isolation {
  set host4 { type ipv4_addr; flags interval; elements = { 203.0.113.9 }; }
  set host6 { type ipv6_addr; flags interval; elements = { 2001:db8::5 }; }
  set blocked4 {
    type ipv4_addr; flags interval;
    elements = { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8,
      169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24,
      192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24,
      224.0.0.0/4, 240.0.0.0/4 };
  }
  set blocked6 {
    type ipv6_addr; flags interval;
    elements = { ::/128, ::1/128, ::ffff:0:0/96, fc00::/7, fe80::/10, ff00::/8 };
  }
  set testdb_ports { type inet_service; elements = { 15432 }; }
  chain output {
    type filter hook output priority 0; policy accept;
    ip daddr 192.0.2.53 udp dport 53 counter accept
    ip daddr 192.0.2.53 tcp dport 53 counter accept
    ip daddr @host4 counter reject
    ip6 daddr @host6 counter reject
    oifname "lo" ip daddr 127.0.0.1 tcp dport @testdb_ports counter accept
    oifname "lo" counter accept
    meta l4proto ipv6-icmp ip6 hoplimit 255 icmpv6 type {
      nd-neighbor-solicit, nd-neighbor-advert, nd-router-solicit
    } accept
    ip daddr @blocked4 counter reject
    ip6 daddr @blocked6 counter reject
  }
}
`);
  });

  it("omits the elements sentence when a host address set is empty", () => {
    const ruleset = buildNftRuleset({
      host4: [],
      host6: [],
      dnsForward4: "192.0.2.53",
      testDatabaseSandboxPort: null,
    });
    expect(ruleset).toContain("set host4 { type ipv4_addr; flags interval; }");
    expect(ruleset).toContain("set host6 { type ipv6_addr; flags interval; }");
    expect(ruleset).not.toContain("elements = {  }");
    expect(ruleset).toContain("set testdb_ports { type inet_service; }");
    expect(ruleset).not.toContain("15432");
  });

  it("keeps DNS acceptance ahead of the blocked ranges that contain the forward address", () => {
    const ruleset = buildNftRuleset({
      host4: [],
      host6: [],
      dnsForward4: "192.0.2.53",
      testDatabaseSandboxPort: null,
    });
    const lines = ruleset.split("\n");
    const dns = lines.findIndex((line) => line.includes("udp dport 53 counter accept"));
    const blocked = lines.findIndex((line) => line.includes("@blocked4 counter reject"));
    expect(dns).toBeGreaterThan(-1);
    expect(blocked).toBeGreaterThan(dns);
  });

  it("de-duplicates and sorts host addresses deterministically", () => {
    const ruleset = buildNftRuleset({
      host4: ["203.0.113.9", "10.8.0.2", "203.0.113.9"],
      host6: [],
      dnsForward4: "192.0.2.53",
    });
    expect(ruleset).toContain("elements = { 10.8.0.2, 203.0.113.9 };");
  });

  it("rejects a malformed host address instead of emitting a bad ruleset", () => {
    expect(() => buildNftRuleset({
      host4: ["203.0.113.9; flush ruleset"],
      host6: [],
      dnsForward4: "192.0.2.53",
    })).toThrow(SessionIsolationUnavailableError);
  });
});

describe("IPv4 literal check", () => {
  it("accepts dotted quads and rejects everything else", () => {
    expect(isIpv4Literal("192.0.2.53")).toBe(true);
    expect(isIpv4Literal("255.255.255.255")).toBe(true);
    expect(isIpv4Literal("256.0.0.1")).toBe(false);
    expect(isIpv4Literal("192.0.2")).toBe(false);
    expect(isIpv4Literal(" 192.0.2.53")).toBe(false);
    expect(isIpv4Literal("2001:db8::1")).toBe(false);
  });
});
