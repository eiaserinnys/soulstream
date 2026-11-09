import { join } from "node:path";

import type { ResolvedMcpServer } from "../mcp_config_service.js";
import type {
  IsolationHostPorts,
  IsolationPreparationInput,
  MountBinding,
  PreparedIsolationPlan,
  PrepareIsolationPlan,
  SessionIsolationSpec,
  WorktreeAttachment,
} from "../security/session_isolation_contract.js";
import { prepareRestrictedAuth } from "./session_auth_preparation.js";
import {
  assertNoSharedMainStoreInodes,
  isolatedCacheEnvironment,
  prepareIsolatedCache,
} from "./session_filesystem_cache.js";
import {
  IsolationPreparationPolicyError,
  SessionIsolationUnavailableError,
} from "./session_filesystem_errors.js";
import { prepareGitView } from "./session_filesystem_git.js";
import { prepareHeavyWorkLocks } from "./session_filesystem_locks.js";
import { prepareIsolationMasks } from "./session_filesystem_masks.js";
import {
  requireAbsolute,
  validateIsolationPreparationInput,
} from "./session_filesystem_policy.js";
import { buildIsolationContextNotice } from "./session_isolation_notice.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

interface WorktreePaths {
  /** 정규 절대 경로(realpath) 목록. */
  canonical: string[];
}

interface ApprovedTestDatabase {
  approved: { hostPort: number; sandboxPort: number };
  url: string;
}

async function requireDirectory(
  ports: IsolationHostPorts,
  path: string,
  label: string,
): Promise<string> {
  const fact = await ports.lstatPath(path);
  if (!fact || fact.kind !== "directory") {
    throw new SessionIsolationUnavailableError(
      `${label} 디렉터리를 찾을 수 없습니다: ${path}`,
    );
  }
  return ports.resolveRealPath(path);
}

async function ensureRealDirectory(
  ports: IsolationHostPorts,
  path: string,
  label: string,
): Promise<string> {
  const fact = await ports.lstatPath(path);
  if (fact && fact.kind !== "directory") {
    throw new SessionIsolationUnavailableError(
      `${label} 경로가 디렉터리가 아닙니다: ${path}`,
    );
  }
  if (!fact) await ports.ensureDirectory(path, 0o700);
  return ports.resolveRealPath(path);
}

async function collectWorktreePaths(
  input: IsolationPreparationInput,
  ports: IsolationHostPorts,
  hostWorkspaceReal: string,
): Promise<WorktreePaths> {
  const registered = new Set(
    input.registeredRepositories.map((repository) => repository.repoId),
  );
  const attachments: WorktreeAttachment[] = [
    ...input.ownedWorktrees,
    ...input.attachedWorktrees,
  ];
  const canonical = new Map<string, string>();
  for (const attachment of attachments) {
    if (!registered.has(attachment.repoId)) {
      throw new IsolationPreparationPolicyError(
        `등록되지 않은 리포의 워크트리입니다: ${attachment.repoId}`,
      );
    }
    requireAbsolute(attachment.canonicalPath, "워크트리");
    const fact = await ports.lstatPath(attachment.canonicalPath);
    if (!fact || fact.kind !== "directory") {
      throw new SessionIsolationUnavailableError(
        `워크트리를 찾을 수 없습니다: ${attachment.canonicalPath}`,
      );
    }
    const real = await ports.resolveRealPath(attachment.canonicalPath);
    if (real !== attachment.canonicalPath) {
      throw new SessionIsolationUnavailableError(
        `워크트리 경로가 정규 경로가 아닙니다: ${attachment.canonicalPath}`,
      );
    }
    if (real === hostWorkspaceReal || real === input.homeDirectory || real === "/") {
      throw new IsolationPreparationPolicyError(
        `워크트리로 열 수 없는 경로입니다: ${real}`,
      );
    }
    canonical.set(real, real);
  }
  return { canonical: [...canonical.values()] };
}

function addBinding(
  bindings: MountBinding[],
  seen: Map<string, boolean>,
  binding: MountBinding,
): void {
  const existing = seen.get(binding.destination);
  if (existing !== undefined) {
    if (existing !== binding.writable) {
      throw new IsolationPreparationPolicyError(
        `bind destination의 권한이 충돌합니다: ${binding.destination}`,
      );
    }
    return;
  }
  seen.set(binding.destination, binding.writable);
  bindings.push(binding);
}

function serverName(server: ResolvedMcpServer): string | null {
  return "name" in server && typeof server.name === "string" ? server.name : null;
}

function serverUrl(server: ResolvedMcpServer): string | null {
  return "url" in server && typeof server.url === "string" ? server.url : null;
}

function portOf(url: string, label: string): number {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new IsolationPreparationPolicyError(`${label} URL 형식이 잘못되었습니다`);
  }
  if (parsed.port) return Number(parsed.port);
  return parsed.protocol === "https:" ? 443 : 80;
}

function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

function resolveApprovedLocalMcp(
  input: IsolationPreparationInput,
  sanitizedServers: readonly ResolvedMcpServer[],
  nodeId: string,
): { serverId: string; hostPort: number; sandboxPort: number }[] {
  const internalPort = portOf(input.actualInternalMcpUrl, "내부 MCP");
  const required: { serverId: string; hostPort: number; sandboxPort: number } = {
    serverId: input.policy.localMcp.requiredServerId,
    hostPort: internalPort,
    sandboxPort: internalPort,
  };
  const approved = [required];
  const optional = new Map(
    input.policy.localMcp.optional
      .filter((entry) => entry.nodeId === nodeId)
      .map((entry) => [entry.serverId, entry.port] as const),
  );

  for (const server of sanitizedServers) {
    const url = serverUrl(server);
    if (!url || !isLoopbackUrl(url)) continue;
    const name = serverName(server);
    const sandboxPort = portOf(url, "로컬 MCP");
    if (name === required.serverId) {
      required.sandboxPort = sandboxPort;
      continue;
    }
    const hostPort = name === null ? undefined : optional.get(name);
    if (name === null || hostPort === undefined) {
      throw new IsolationPreparationPolicyError(
        `승인되지 않은 로컬 MCP 서버입니다: ${name ?? "(이름 없음)"}`,
      );
    }
    approved.push({ serverId: name, hostPort, sandboxPort });
  }
  return approved;
}

function resolveApprovedTestDatabase(
  input: IsolationPreparationInput,
  nodeId: string,
): ApprovedTestDatabase | null {
  if (!input.testDatabaseUrl) return null;
  const entry = input.policy.testDatabases.find((candidate) => candidate.nodeId === nodeId);
  if (!entry) {
    throw new IsolationPreparationPolicyError(
      "이 노드에 승인된 시험 DB 항목이 없습니다",
    );
  }
  let url: URL;
  try {
    url = new URL(input.testDatabaseUrl);
  } catch {
    throw new IsolationPreparationPolicyError("시험 DB URL 형식이 잘못되었습니다");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new IsolationPreparationPolicyError("시험 DB URL이 postgres URL이 아닙니다");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new IsolationPreparationPolicyError("시험 DB endpoint가 loopback이 아닙니다");
  }
  const port = url.port ? Number(url.port) : 5432;
  if (port !== entry.hostPort) {
    throw new IsolationPreparationPolicyError("시험 DB endpoint 포트가 승인값과 다릅니다");
  }
  if (url.search !== "" || url.hash !== "") {
    // 질의 문자열로 승인 밖 endpoint를 지정할 수 있으면 안 된다.
    throw new IsolationPreparationPolicyError("시험 DB URL에 질의 문자열이 있습니다");
  }
  let database: string;
  try {
    database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch {
    throw new IsolationPreparationPolicyError("시험 DB 이름 형식이 잘못되었습니다");
  }
  if (!database.toLowerCase().includes("test")) {
    throw new IsolationPreparationPolicyError("시험 DB 이름에 test가 없습니다");
  }
  url.hostname = "127.0.0.1";
  url.port = String(entry.sandboxPort);
  return {
    approved: { hostPort: entry.hostPort, sandboxPort: entry.sandboxPort },
    url: url.toString(),
  };
}

function composeBindings(args: {
  workspaceReal: string;
  hostWorkspaceReal: string;
  worktrees: readonly string[];
  sandbox: string;
  sessionWorktreeRoot: string;
  localTmp: string;
  artifacts: string;
  cacheBindings: readonly MountBinding[];
  authBindings: readonly MountBinding[];
  maskRebindings: readonly MountBinding[];
  gitBindings: readonly MountBinding[];
  resolvConfPath: string;
}): MountBinding[] {
  const bindings: MountBinding[] = [];
  const seen = new Map<string, boolean>();
  const push = (binding: MountBinding): void => addBinding(bindings, seen, binding);

  // worktree가 없을 때만 workspace를 RO로 고정한다(스펙 §8). worktree RW bind는
  // workspace RO bind 뒤에 두어 부모 RO가 자식 RW를 덮지 않게 한다.
  if (args.worktrees.length === 0) {
    push({
      source: args.workspaceReal,
      destination: args.workspaceReal,
      writable: false,
    });
  }
  push({
    source: args.localTmp,
    destination: join(args.hostWorkspaceReal, ".local/tmp"),
    writable: true,
  });
  push({
    source: args.artifacts,
    destination: join(args.hostWorkspaceReal, ".local/artifacts"),
    writable: true,
  });
  for (const worktree of args.worktrees) {
    push({ source: worktree, destination: worktree, writable: true });
  }
  push({
    source: args.sessionWorktreeRoot,
    destination: args.sessionWorktreeRoot,
    writable: true,
  });
  for (const binding of args.cacheBindings) push(binding);
  push({ source: args.sandbox, destination: args.sandbox, writable: true });
  for (const binding of args.authBindings) push(binding);
  for (const binding of args.maskRebindings) push(binding);
  for (const binding of args.gitBindings) push(binding);
  push({
    source: args.resolvConfPath,
    destination: "/etc/resolv.conf",
    writable: false,
  });
  return bindings;
}

/**
 * B2: restricted 턴을 시작하기 전에 호스트가 준비할 파일·환경·인증 계획을 만든다.
 * 부수효과는 주입된 포트로만 일으키며, 비밀값은 env에만 담는다.
 */
export const prepareIsolationPlan: PrepareIsolationPlan = async (input, ports) => {
  validateIsolationPreparationInput(input);

  const nodeId = await ports.resolveNodeId();
  const sanitizedServers = await ports.sanitizeMcpServers(input.resolvedServers, input.policy);
  const approvedLocalMcp = resolveApprovedLocalMcp(input, sanitizedServers, nodeId);
  const approvedTestDatabase = resolveApprovedTestDatabase(input, nodeId);

  const workspaceReal = await requireDirectory(ports, input.workspaceDir, "workspace");
  const hostWorkspaceReal = await requireDirectory(
    ports,
    input.hostWorkspaceRoot,
    "host workspace",
  );
  await ports.ensureDirectory(input.sessionDirectory, 0o700);
  const sandboxInput = join(input.sessionDirectory, "sandbox");
  await ports.ensureDirectory(sandboxInput, 0o700);
  const sandbox = await ports.resolveRealPath(sandboxInput);

  const sessionWorktreeRootInput = join(
    hostWorkspaceReal,
    input.policy.filesystem.sessionWorktreeRelativeRoot,
    input.decision.sessionId,
  );
  await ports.ensureDirectory(sessionWorktreeRootInput, 0o700);
  const sessionWorktreeRoot = await ports.resolveRealPath(sessionWorktreeRootInput);

  const auth = await prepareRestrictedAuth(input, ports, sandbox);
  const wsl = await ports.detectWsl();
  const maskPlan = await prepareIsolationMasks({
    input,
    ports,
    wsl,
    extraMasks: auth.masks,
  });
  const cache = await prepareIsolatedCache({ input, ports });

  const worktrees = await collectWorktreePaths(input, ports, hostWorkspaceReal);
  await assertNoSharedMainStoreInodes({
    worktreeRoots: worktrees.canonical,
    ports,
  });
  const gitBindings = await prepareGitView({
    input,
    ports,
    sandboxDirectory: sandbox,
  });
  const locks = await prepareHeavyWorkLocks(ports);

  const localTmp = await ensureRealDirectory(
    ports,
    join(hostWorkspaceReal, ".local/tmp"),
    "workspace .local/tmp",
  );
  const artifacts = await ensureRealDirectory(
    ports,
    join(hostWorkspaceReal, ".local/artifacts"),
    "workspace .local/artifacts",
  );

  const restrictedCredential = await ports.issueRestrictedCredential(
    input.decision.sessionId,
  );
  const githubEnvironment = await ports.prepareGitHubCredential();
  const ghConfigDirectory = join(sandbox, "gh");
  await ports.ensureDirectory(ghConfigDirectory, 0o700);

  const env: Record<string, string> = {
    ...isolatedCacheEnvironment(cache.root, input.homeDirectory),
    ...auth.env,
    ...githubEnvironment,
    GH_CONFIG_DIR: ghConfigDirectory,
    AUTH_BEARER_TOKEN: restrictedCredential,
  };
  if (approvedTestDatabase) {
    env.TEST_DATABASE_URL = approvedTestDatabase.url;
  }

  const resolvConfPath = join(sandbox, "resolv.conf");
  await ports.writeFile(
    resolvConfPath,
    `nameserver ${input.policy.network.dnsForward4}\n`,
    0o644,
  );

  const bindings = composeBindings({
    workspaceReal,
    hostWorkspaceReal,
    worktrees: worktrees.canonical,
    sandbox,
    sessionWorktreeRoot,
    localTmp,
    artifacts,
    cacheBindings: cache.bindings,
    authBindings: auth.bindings,
    maskRebindings: maskPlan.rebindings,
    gitBindings,
    resolvConfPath,
  });
  const masks = maskPlan.masks;

  const spec: SessionIsolationSpec = {
    version: 1,
    enabled: true,
    sessionId: input.decision.sessionId,
    backend: input.backend,
    workspaceDir: workspaceReal,
    scratchWorkspaceDir: input.scratchWorkspaceDir,
    sandboxDirectory: sandbox,
    sessionWorktreeRoot,
    authKind: auth.kind,
    policyDigest: input.policyDigest,
    bindings,
    masks,
    heavyWorkLockBindings: locks.heavyWorkLockBindings,
    hostProcLocksBinding: locks.hostProcLocksBinding,
    approvedLocalMcp,
    approvedTestDatabase: approvedTestDatabase?.approved ?? null,
  };

  const contextNotice = buildIsolationContextNotice({
    scratchWorkspaceDir: input.scratchWorkspaceDir,
    writeRoots: [
      localTmp,
      artifacts,
      sessionWorktreeRoot,
      ...worktrees.canonical,
      cache.root,
    ],
  });

  const prepared: PreparedIsolationPlan = {
    spec,
    sanitizedServers,
    env,
    resolvConfPath,
    contextNotice,
  };
  return prepared;
};
