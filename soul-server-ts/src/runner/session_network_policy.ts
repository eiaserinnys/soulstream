import type { NetworkInterfaceInfo } from "node:os";

import type { SessionIsolationSpec } from "../security/session_isolation_contract.js";

import { SessionIsolationUnavailableError } from "./session_isolation_preflight.js";

/**
 * sandbox 안에서만 쓰는 DNS 전달 주소. 정책·nft 규칙·resolv.conf가 같은 값을
 * 공유하며, pasta가 이 주소로 온 질의를 호스트 resolver로 전달한다.
 */
export const ISOLATION_DNS_FORWARD_ADDRESS = "192.0.2.53";

/** sandbox `/etc/resolv.conf`의 유일한 내용. */
export function buildSessionResolvConf(): string {
  return `nameserver ${ISOLATION_DNS_FORWARD_ADDRESS}\n`;
}

export type HostAddressFamily = "ipv4" | "ipv6";

export interface HostAddress {
  readonly address: string;
  readonly family: HostAddressFamily;
}

export interface NftRulesetInput {
  /** loopback을 제외한 호스트 자신의 IPv4 주소. */
  readonly host4: readonly string[];
  /** loopback을 제외한 호스트 자신의 IPv6 주소. */
  readonly host6: readonly string[];
  /** sandbox resolv.conf가 가리키는 전달 주소. */
  readonly dnsForward4: string;
  /** 승인된 전용 시험 DB의 sandbox 포트. 없으면 null. */
  readonly testDatabaseSandboxPort?: number | null;
}

export interface PastaArgvInput {
  readonly pastaPath: string;
  /** netns helper를 띄운 프로세스의 호스트 PID. */
  readonly namespaceOwnerPid: number;
  /**
   * pasta `-T`에 넘길 전달 목록. sandbox 포트와 host 포트가 다르면
   * `sandbox:host`, 같으면 `sandbox` 한 값이다.
   */
  readonly forwardedPorts: readonly string[];
  readonly dnsForward4: string;
  /** 호스트의 실제 IPv4 resolver. */
  readonly hostResolver: string;
}

const IPV4_LITERAL = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/;

/**
 * 호스트 interface 목록에서 loopback을 뺀 자기 주소를 모은다. pasta가 붙기
 * 전에 호스트 자신의 주소로 나가는 경로를 nft에서 거부하기 위한 입력이다.
 */
export function collectHostAddresses(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): HostAddress[] {
  const addresses = new Map<string, HostAddress>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      const address = normalizeAddress(entry.address);
      if (entry.family === "IPv4") {
        if (isLoopbackIpv4(address)) continue;
        addresses.set(`ipv4:${address}`, { address, family: "ipv4" });
        continue;
      }
      if (entry.family === "IPv6") {
        if (address === "::1") continue;
        addresses.set(`ipv6:${address}`, { address, family: "ipv6" });
      }
    }
  }
  return [...addresses.values()].sort((left, right) =>
    left.family === right.family
      ? left.address.localeCompare(right.address)
      : left.family.localeCompare(right.family));
}

/** resolv.conf 텍스트에서 첫 IPv4 nameserver를 고른다. */
export function parseHostIpv4Resolver(resolvConf: string): string | null {
  for (const line of resolvConf.split(/\r?\n/)) {
    const match = /^\s*nameserver\s+(\S+)\s*$/.exec(line);
    const candidate = match?.[1];
    if (candidate === undefined) continue;
    if (isIpv4Literal(candidate)) return candidate;
  }
  return null;
}

/**
 * sandbox resolv.conf가 정확히 전달 주소 한 줄인지 확인한다.
 *
 * 첫 IPv4 nameserver만 받으면 같은 파일에 다른 resolver가 덧붙어 있어도
 * 통과한다. sandbox는 이 파일 하나로 DNS를 쓰므로, 내용 전체가 우리가 쓰는
 * `buildSessionResolvConf()`와 같은지만 본다. 다르면 null이고, 호출자가
 * SESSION_ISOLATION_UNAVAILABLE로 거부한다.
 */
export function parseSandboxDnsForwardAddress(resolvConf: string): string | null {
  return resolvConf === buildSessionResolvConf() ? ISOLATION_DNS_FORWARD_ADDRESS : null;
}

/**
 * 그 세션 하나에 필요한 pasta `-T` 전달 목록을 만든다.
 *
 * `-T`는 target namespace(sandbox) 포트에서 init namespace(host) 포트로
 * 전달한다. sandbox의 CLI는 승인 MCP·시험 DB에 sandbox 포트로 접속하는데,
 * 실제 서버는 host 포트에서 듣는다. 그래서 둘이 다르면 `sandbox:host`로
 * 적어야 하고, sandbox 포트만 적으면 host의 같은 번호로 가 아무도 받지
 * 않는다.
 */
export function computePastaForwardedPorts(plan: SessionIsolationSpec): string[] {
  const forwarded = new Map<number, number>();
  for (const server of plan.approvedLocalMcp) {
    assertPort(server.sandboxPort, "approved local MCP sandbox port");
    assertPort(server.hostPort, "approved local MCP host port");
    forwarded.set(server.sandboxPort, server.hostPort);
  }
  const testDatabase = plan.approvedTestDatabase;
  if (testDatabase !== null) {
    assertPort(testDatabase.sandboxPort, "approved test database sandbox port");
    assertPort(testDatabase.hostPort, "approved test database host port");
    forwarded.set(testDatabase.sandboxPort, testDatabase.hostPort);
  }
  return [...forwarded.entries()]
    .sort(([left], [right]) => left - right)
    .map(([sandboxPort, hostPort]) =>
      sandboxPort === hostPort ? `${sandboxPort}` : `${sandboxPort}:${hostPort}`);
}

/**
 * §6의 nft 규칙 전문을 만든다. host 주소 집합이 비면 `elements` 문장을
 * 통째로 생략하고, 승인 시험 DB가 없으면 testdb 포트 set을 비워 둔다.
 */
export function buildNftRuleset(input: NftRulesetInput): string {
  const host4 = normalizeAddressSet(input.host4, "IPv4");
  const host6 = normalizeAddressSet(input.host6, "IPv6");
  if (!isIpv4Literal(input.dnsForward4)) {
    throw new SessionIsolationUnavailableError(
      `dns forward address is not an IPv4 literal: ${input.dnsForward4}`,
    );
  }
  const testDatabasePort = input.testDatabaseSandboxPort ?? null;
  if (testDatabasePort !== null) assertPort(testDatabasePort, "test database sandbox port");

  const lines = [
    "table inet soulstream_isolation {",
    renderAddressSet("host4", "ipv4_addr", host4),
    renderAddressSet("host6", "ipv6_addr", host6),
    "  set blocked4 {",
    "    type ipv4_addr; flags interval;",
    "    elements = { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8,",
    "      169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24,",
    "      192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24,",
    "      224.0.0.0/4, 240.0.0.0/4 };",
    "  }",
    "  set blocked6 {",
    "    type ipv6_addr; flags interval;",
    "    elements = { ::/128, ::1/128, ::ffff:0:0/96, fc00::/7, fe80::/10, ff00::/8 };",
    "  }",
    testDatabasePort === null
      ? "  set testdb_ports { type inet_service; }"
      : `  set testdb_ports { type inet_service; elements = { ${testDatabasePort} }; }`,
    "  chain output {",
    "    type filter hook output priority 0; policy accept;",
    `    ip daddr ${input.dnsForward4} udp dport 53 counter accept`,
    `    ip daddr ${input.dnsForward4} tcp dport 53 counter accept`,
    "    ip daddr @host4 counter reject",
    "    ip6 daddr @host6 counter reject",
    '    oifname "lo" ip daddr 127.0.0.1 tcp dport @testdb_ports counter accept',
    '    oifname "lo" counter accept',
    "    meta l4proto ipv6-icmp ip6 hoplimit 255 icmpv6 type {",
    "      nd-neighbor-solicit, nd-neighbor-advert, nd-router-solicit",
    "    } accept",
    "    ip daddr @blocked4 counter reject",
    "    ip6 daddr @blocked6 counter reject",
    "  }",
    "}",
  ];
  return `${lines.join("\n")}\n`;
}

/** §6의 pasta argv. 자동 전달·호스트 loopback 매핑을 쓰지 않는다. */
export function buildPastaArgv(input: PastaArgvInput): [string, ...string[]] {
  assertNamespaceOwnerPid(input.namespaceOwnerPid);
  if (!isIpv4Literal(input.dnsForward4)) {
    throw new SessionIsolationUnavailableError(
      `dns forward address is not an IPv4 literal: ${input.dnsForward4}`,
    );
  }
  if (!isIpv4Literal(input.hostResolver)) {
    throw new SessionIsolationUnavailableError(
      `host resolver is not an IPv4 literal: ${input.hostResolver}`,
    );
  }
  const ports = [...input.forwardedPorts];
  for (const port of ports) assertForwardSpec(port);

  return [
    input.pastaPath,
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
    ports.length === 0 ? "none" : ports.join(","),
    "--dns-forward",
    input.dnsForward4,
    "--dns-host",
    input.hostResolver,
    "--userns",
    `/proc/${input.namespaceOwnerPid}/ns/user`,
    "--netns",
    `/proc/${input.namespaceOwnerPid}/ns/net`,
  ];
}

export function assertNamespaceOwnerPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new SessionIsolationUnavailableError(
      `namespace owner pid is not a positive integer: ${String(pid)}`,
    );
  }
}

function renderAddressSet(
  name: "host4" | "host6",
  family: "ipv4_addr" | "ipv6_addr",
  values: readonly string[],
): string {
  const head = `  set ${name} { type ${family}; flags interval;`;
  if (values.length === 0) return `${head} }`;
  return `${head} elements = { ${values.join(", ")} }; }`;
}

function normalizeAddressSet(
  values: readonly string[],
  family: "IPv4" | "IPv6",
): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const address = normalizeAddress(value);
    const valid = family === "IPv4" ? isIpv4Literal(address) : isIpv6Literal(address);
    if (!valid) {
      throw new SessionIsolationUnavailableError(
        `host address is not a valid ${family} literal: ${value}`,
      );
    }
    unique.add(address);
  }
  return [...unique].sort((left, right) => left.localeCompare(right));
}

function normalizeAddress(value: string): string {
  const scopeIndex = value.indexOf("%");
  return scopeIndex === -1 ? value : value.slice(0, scopeIndex);
}

function isLoopbackIpv4(address: string): boolean {
  return address.startsWith("127.");
}

export function isIpv4Literal(value: string): boolean {
  if (!IPV4_LITERAL.test(value)) return false;
  return value.split(".").every((octet) => Number(octet) <= 255);
}

function isIpv6Literal(value: string): boolean {
  return value.includes(":");
}

function assertPort(port: number, label: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SessionIsolationUnavailableError(
      `${label} is not a valid port: ${String(port)}`,
    );
  }
}

/** pasta `-T` 값 하나(`sandbox` 또는 `sandbox:host`)를 검증한다. */
function assertForwardSpec(spec: string): void {
  const parts = spec.split(":");
  if (parts.length > 2) {
    throw new SessionIsolationUnavailableError(`pasta forwarded port is malformed: ${spec}`);
  }
  for (const part of parts) {
    if (!/^[1-9]\d{0,4}$/.test(part)) {
      throw new SessionIsolationUnavailableError(`pasta forwarded port is malformed: ${spec}`);
    }
    assertPort(Number(part), "pasta forwarded port");
  }
}
