import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import type { IsolationPolicy } from "./session_isolation_contract.js";
import { ISOLATION_POLICY_UNAVAILABLE } from "./session_execution_policy.js";

/**
 * restricted 실행 정책 파일의 정본 loader.
 *
 * 정본은 리포 추적 `src/policies/session-isolation.json` 하나이며 노드별 복사본을
 * 두지 않는다. 로드·검증 실패는 restricted 시작만 거부하고 full 서버는 그대로
 * 동작한다. 빈 정책으로 fallback하지 않는다.
 */

const TOOL_GUARDS = [
  "draft-card",
  "card-status",
  "worktree-create",
  "owned-worktree",
  "message-recipient",
] as const;

const toolPolicySchema = z.discriminatedUnion("category", [
  z.object({ category: z.literal("allow") }).strict(),
  z.object({ category: z.literal("deny") }).strict(),
  z.object({ category: z.literal("guarded"), guard: z.enum(TOOL_GUARDS) }).strict(),
  z.object({ category: z.literal("inherit"), guard: z.literal("create-local-session") }).strict(),
]);

const localMcpSchema = z.object({
  requiredServerId: z.literal("soulstream"),
  optional: z.array(z.object({
    serverId: z.string().min(1),
    nodeId: z.string().min(1),
    port: z.number().int().min(1).max(65535),
  }).strict()),
}).strict();

const filesystemSchema = z.object({
  sessionWorktreeRelativeRoot: z.literal(".projects/.isolated"),
  credentialRelativeDirectory: z.literal(".local/share/soulstream/credentials/codex"),
  isolatedCacheRelativeRoot: z.literal(".local/share/soulstream/isolated-cache"),
  writableWorkspaceRelativeDirectories: z.tuple([
    z.literal(".local/tmp"),
    z.literal(".local/artifacts"),
  ]),
  additionalSensitiveRoots: z.array(z.string().min(1)),
}).strict();

const networkSchema = z.object({
  mode: z.literal("pasta-nft"),
  dnsForward4: z.literal("192.0.2.53"),
  deniedIpv4: z.array(cidrSchema(4)),
  deniedIpv6: z.array(cidrSchema(6)),
}).strict();

const policySchema = z.object({
  version: z.literal(1),
  tools: z.record(z.string().min(1), toolPolicySchema).refine(
    (tools) => Object.keys(tools).length > 0,
    { message: "tools must classify at least one tool" },
  ),
  localMcp: localMcpSchema,
  filesystem: filesystemSchema,
  testDatabases: z.array(z.object({
    nodeId: z.string().min(1),
    hostPort: z.number().int().min(1).max(65535),
    sandboxPort: z.number().int().min(1).max(65535),
  }).strict()),
  network: networkSchema,
}).strict();

export interface LoadedIsolationPolicy {
  policy: IsolationPolicy;
  digest: string;
}

export interface IsolationPolicyProvider {
  /** 성공한 로드만 캐시한다. 실패는 다음 호출에서 다시 읽는다. */
  get(): LoadedIsolationPolicy;
}

export interface IsolationPolicyLoaderDependencies {
  path?: string;
  readFile?: (path: string) => string;
}

export class IsolationPolicyFileError extends Error {
  readonly code = ISOLATION_POLICY_UNAVAILABLE;

  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "IsolationPolicyFileError";
  }
}

export function defaultIsolationPolicyPath(): string {
  return fileURLToPath(new URL("../policies/session-isolation.json", import.meta.url));
}

export function parseIsolationPolicy(raw: unknown): IsolationPolicy {
  const parsed = policySchema.safeParse(raw);
  if (!parsed.success) {
    throw new IsolationPolicyFileError(
      `invalid isolation policy: ${describeIssues(parsed.error.issues)}`,
    );
  }
  const policy: IsolationPolicy = parsed.data;
  return policy;
}

export function computeIsolationPolicyDigest(policy: IsolationPolicy): string {
  return createHash("sha256").update(canonicalJson(policy)).digest("hex");
}

export function loadIsolationPolicyFile(
  path: string,
  deps: Pick<IsolationPolicyLoaderDependencies, "readFile"> = {},
): LoadedIsolationPolicy {
  const readFile = deps.readFile ?? ((target: string) => readFileSync(target, "utf8"));
  let text: string;
  try {
    text = readFile(path);
  } catch (error) {
    throw new IsolationPolicyFileError(`isolation policy file is unreadable: ${path}`, error);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new IsolationPolicyFileError(`isolation policy is not valid JSON: ${path}`, error);
  }
  const policy = parseIsolationPolicy(raw);
  return { policy, digest: computeIsolationPolicyDigest(policy) };
}

export function createIsolationPolicyProvider(
  deps: IsolationPolicyLoaderDependencies = {},
): IsolationPolicyProvider {
  const path = deps.path ?? defaultIsolationPolicyPath();
  let cached: LoadedIsolationPolicy | undefined;
  return {
    get(): LoadedIsolationPolicy {
      if (cached) return cached;
      cached = loadIsolationPolicyFile(path, deps);
      return cached;
    },
  };
}

function cidrSchema(family: 4 | 6) {
  const maximum = family === 4 ? 32 : 128;
  return z.string().refine((value) => isValidCidr(value, family, maximum), {
    message: `expected an IPv${family} CIDR`,
  });
}

function isValidCidr(value: string, family: 4 | 6, maximumPrefix: number): boolean {
  const parts = value.split("/");
  if (parts.length !== 2) return false;
  const [address, prefix] = parts;
  if (!address || !prefix || isIP(address) !== family) return false;
  if (!/^(0|[1-9][0-9]*)$/.test(prefix)) return false;
  const bits = Number(prefix);
  return Number.isInteger(bits) && bits >= 0 && bits <= maximumPrefix;
}

function describeIssues(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): string {
  return issues
    .slice(0, 8)
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return `${path || "(root)"}: ${issue.message}`;
    })
    .join("; ");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
