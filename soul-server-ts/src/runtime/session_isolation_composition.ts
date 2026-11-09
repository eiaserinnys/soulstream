import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Env } from "../config.js";
import type { CodexCliPathResolution } from "../engine/codex_cli_path.js";
import { localInternalMcpUrl } from "../mcp/endpoint_paths.js";
import type { McpConfigService } from "../mcp_config_service.js";
import { SessionIsolationUnavailableError } from "../runner/session_filesystem_errors.js";
import { prepareIsolationPlan } from "../runner/session_filesystem_plan.js";
import { createIsolationHostPorts } from "../runner/session_isolation_host_ports.js";
import { runnerProcessPaths } from "../runner/runner_process_paths.js";
import {
  restrictedIsolationBackend,
  type IsolationToolPaths,
  type PreparedRunnerIsolation,
  type RunnerIsolationHost,
  type RunnerIsolationPreparationRequest,
} from "../runner/runner_process_isolation.js";
import type {
  IsolationMask,
  IsolationPreparationInput,
  RegisteredRepository,
  WorktreeAttachment,
} from "../security/session_isolation_contract.js";
import {
  createSessionIsolationRuntime,
  sessionIsolationSettingsFromEnv,
  type SessionIsolationRuntime,
} from "../security/session_isolation_runtime.js";
import type { WorktreeService } from "../worktree/worktree_service.js";

export interface SessionIsolationCompositionDeps {
  env: Env;
  worktreeService?: Pick<WorktreeService, "list" | "listRepositoryIds"> | undefined;
  mcpConfigService: Pick<McpConfigService, "resolveMcpProfile">;
  codexCliPath?: CodexCliPathResolution | undefined;
}

export interface SessionIsolationComposition {
  /** restricted 판정과 정책 digest의 유일한 원천. */
  runtime: SessionIsolationRuntime;
  /** restricted 러너 준비 경로. 팩토리에 주입될 때만 isolationSupported가 true가 된다. */
  host: RunnerIsolationHost;
  /**
   * 이 세션이 실제로 mount하는 worktree id 전체(소유+부착). prepare의 mount
   * 집합과 같은 수집 함수를 쓰므로 재사용 판정과 child config가 어긋나지 않는다.
   */
  worktreeAttachmentIds(
    sessionId: string,
    taskWorktreeId: string | undefined,
  ): Promise<readonly string[]>;
}

/**
 * 격리 조립은 이 함수 한 곳에서만 한다. `SESSION_ISOLATION_MODE=off`면
 * undefined이고, 이때 판정 호출과 정책 파일 읽기는 0회다.
 */
export function composeSessionIsolation(
  deps: SessionIsolationCompositionDeps,
): SessionIsolationComposition | undefined {
  const { env } = deps;
  if (env.SESSION_ISOLATION_MODE === "off") return undefined;
  const runtime = createSessionIsolationRuntime({
    nodeId: env.SOULSTREAM_NODE_ID,
    settings: sessionIsolationSettingsFromEnv(env),
  });
  return {
    runtime,
    host: createRunnerIsolationHost(deps, runtime),
    worktreeAttachmentIds: async (sessionId, taskWorktreeId) => (await collectSessionWorktrees({
      worktreeService: deps.worktreeService,
      actorSessionId: sessionId,
      taskWorktreeId,
    })).worktreeIds,
  };
}

function createRunnerIsolationHost(
  deps: SessionIsolationCompositionDeps,
  runtime: SessionIsolationRuntime,
): RunnerIsolationHost {
  return {
    prepare: async (request) => await prepareRunnerIsolation(deps, runtime, request),
  };
}

/**
 * restricted 턴 하나의 러너 준비. B2(`prepareIsolationPlan`)는 이 턴에 한 번만
 * 부르고, 세션 범위 부수효과는 B3a 포트가 전담한다.
 */
async function prepareRunnerIsolation(
  deps: SessionIsolationCompositionDeps,
  runtime: SessionIsolationRuntime,
  request: RunnerIsolationPreparationRequest,
): Promise<PreparedRunnerIsolation> {
  const { env } = deps;
  const decision = request.task.executionSecurity;
  if (!decision || decision.tier !== "restricted") {
    throw new SessionIsolationUnavailableError(
      "SESSION_ISOLATION_UNAVAILABLE: isolation host is used only for restricted turns",
    );
  }
  const backend = restrictedIsolationBackend(request.backend);
  const stateDirectory = env.SOUL_RUNNER_STATE_DIR;
  if (!stateDirectory) {
    throw new SessionIsolationUnavailableError(
      "SESSION_ISOLATION_UNAVAILABLE: SOUL_RUNNER_STATE_DIR is required for restricted runners",
    );
  }
  const tools = isolationTools(runtime);
  const homeDirectory = homedir();
  const uid = posixUid();
  const loaded = runtime.policySource.get();
  const actualInternalMcpUrl = localInternalMcpUrl(env.MCP_INTERNAL_PORT, env.MCP_PATH);
  const codexExecutable = await resolveCodexExecutable(deps.codexCliPath?.path);
  if (backend === "codex" && !codexExecutable) {
    throw new SessionIsolationUnavailableError(
      "SESSION_ISOLATION_UNAVAILABLE: restricted Codex requires its executable path",
    );
  }
  const ports = createIsolationHostPorts({
    sessionId: decision.sessionId,
    nodeId: env.SOULSTREAM_NODE_ID,
    hostBearerToken: env.AUTH_BEARER_TOKEN,
    actualInternalMcpUrl,
    homeDirectory,
    uid,
    agentCommonFilesDirectory: process.env.AGENT_COMMON_FILES_DIR ?? null,
    // dotenv가 읽는 디렉터리는 프로세스 cwd다(main.ts의 상대 경로 계약).
    serviceEnvironmentDirectory: process.cwd(),
    claudeTokenFile: runtime.settings.claudeTokenFile,
    codexExecutable,
  });
  const worktrees = await collectWorktreeFacts({
    worktreeService: deps.worktreeService,
    projectsRoot: env.WORKTREE_PROJECTS_ROOT,
    actorSessionId: decision.sessionId,
    taskWorktreeId: request.task.worktreeId,
    resolveCommonDir: async (repositoryPath) => await ports.resolveGitCommonDir(repositoryPath),
  });
  const input: IsolationPreparationInput = {
    decision,
    backend,
    workspaceDir: request.agent.workspace_dir,
    sessionDirectory: sessionDirectoryFor(stateDirectory, decision.sessionId),
    // 워크트리 턴이면 agent는 워크트리 경로로 치환돼 있다. B2의 host 검사는
    // 치환 전 프로필 경로를 기준으로 한다.
    hostWorkspaceRoot: request.task.profileWorkspaceDir ?? request.agent.workspace_dir,
    homeDirectory,
    uid,
    policy: loaded.policy,
    policyDigest: loaded.digest,
    resolvedServers: deps.mcpConfigService.resolveMcpProfile(request.agent)?.mcp_servers ?? [],
    actualInternalMcpUrl,
    ownedWorktrees: worktrees.owned,
    attachedWorktrees: worktrees.attached,
    registeredRepositories: worktrees.repositories,
    authPreparation: runtime.classifyAuth({
      backend,
      // 실제 턴 환경과 같은 규칙: 해석된 프리셋이 있으면 그 env만 본다.
      presetEnv: request.task.modelPresetBackend !== undefined
        ? (request.task.modelPresetEnv ?? {})
        : (request.agent.env ?? null),
      homeDirectory,
    }),
    ...(runtime.settings.testDatabaseUrl !== null
      ? { testDatabaseUrl: runtime.settings.testDatabaseUrl }
      : {}),
    scratchWorkspaceDir: request.agent.workspace_dir,
  };
  const plan = await prepareIsolationPlan(input, ports);
  if (backend === "codex" && codexExecutable) {
    assertCodexExecutableOutsideMasks(
      codexExecutable,
      deps.codexCliPath?.path ?? codexExecutable,
      plan.spec.masks,
    );
  }
  return {
    plan,
    wsl: await ports.detectWsl(),
    tools,
    attachedWorktreeIds: worktrees.worktreeIds,
  };
}

function isolationTools(runtime: SessionIsolationRuntime): IsolationToolPaths {
  const { bwrap, pasta, unshare, setpriv, nft, netnsHelper } = runtime.tools;
  if (!pasta) {
    throw new SessionIsolationUnavailableError(
      "SESSION_ISOLATION_UNAVAILABLE: SESSION_ISOLATION_PASTA_PATH is required for restricted execution",
    );
  }
  return { bwrap, pasta, unshare, setpriv, nft, netnsHelper };
}

function posixUid(): number {
  const getuid = process.getuid;
  if (typeof getuid !== "function") {
    throw new SessionIsolationUnavailableError(
      "SESSION_ISOLATION_UNAVAILABLE: restricted execution requires a POSIX uid",
    );
  }
  return getuid.call(process);
}

function sessionDirectoryFor(stateDirectory: string, sessionId: string): string {
  try {
    return runnerProcessPaths(stateDirectory, sessionId).sessionDirectory;
  } catch (error) {
    throw new SessionIsolationUnavailableError(
      "SESSION_ISOLATION_UNAVAILABLE: runner session directory is unavailable",
      error,
    );
  }
}

async function resolveCodexExecutable(path: string | undefined): Promise<string | null> {
  if (!path) return null;
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/** 마스크 안의 실행 파일은 restricted 자식이 실행할 수 없다. */
function assertCodexExecutableOutsideMasks(
  executable: string,
  literalPath: string,
  masks: readonly IsolationMask[],
): void {
  for (const mask of masks) {
    for (const candidate of executable === literalPath
      ? [executable]
      : [executable, literalPath]) {
      const inside = mask.kind === "directory"
        ? candidate === mask.path || candidate.startsWith(`${mask.path}/`)
        : candidate === mask.path;
      if (inside) {
        throw new SessionIsolationUnavailableError(
          "SESSION_ISOLATION_UNAVAILABLE: the Codex executable lives inside a masked path",
        );
      }
    }
  }
}

interface SessionWorktreeRow {
  worktreeId: string | null;
  repoId: string;
  path: string;
  discoveryKind: string | null;
  dbState: string | null;
  ownerKind: string | null;
  ownerId: string | null;
  activeSessionId: string | null;
}

interface EligibleWorktree {
  worktreeId: string;
  repoId: string;
  path: string;
}

interface SessionWorktrees {
  owned: EligibleWorktree[];
  attached: EligibleWorktree[];
  /** 소유와 부착을 합친 실제 mount 집합. 정렬·중복 제거. */
  worktreeIds: readonly string[];
}

interface WorktreeFacts {
  owned: WorktreeAttachment[];
  attached: WorktreeAttachment[];
  repositories: RegisteredRepository[];
  worktreeIds: readonly string[];
}

/**
 * 이 세션이 소유하거나 붙은 worktree만 고른다. `worktreeService.list`는
 * 레코드와 git 발견을 합친 행을 돌려주므로 필드 타입을 여기서 좁힌다.
 * 턴 게이트와 prepare가 이 함수 하나를 공유한다.
 */
async function collectSessionWorktrees(args: {
  worktreeService: Pick<WorktreeService, "list"> | undefined;
  actorSessionId: string;
  taskWorktreeId: string | undefined;
}): Promise<SessionWorktrees> {
  if (!args.worktreeService) {
    if (args.taskWorktreeId) {
      throw new SessionIsolationUnavailableError(
        "SESSION_ISOLATION_UNAVAILABLE: this turn runs in a worktree but the worktree service is unavailable",
      );
    }
    return { owned: [], attached: [], worktreeIds: [] };
  }
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await args.worktreeService.list({ actorSessionId: args.actorSessionId });
  } catch (error) {
    throw new SessionIsolationUnavailableError(
      "SESSION_ISOLATION_UNAVAILABLE: worktree inventory failed",
      error,
    );
  }
  const owned: EligibleWorktree[] = [];
  const attached: EligibleWorktree[] = [];
  for (const raw of rows) {
    const row = readWorktreeRow(raw);
    if (!row) continue;
    const worktree = eligibleWorktree(row);
    if (!worktree) continue;
    if (row.ownerKind === "session" && row.ownerId === args.actorSessionId) {
      owned.push(worktree);
      continue;
    }
    if (
      row.activeSessionId === args.actorSessionId
      || worktree.worktreeId === args.taskWorktreeId
    ) {
      attached.push(worktree);
    }
  }
  if (
    args.taskWorktreeId !== undefined
    && ![...owned, ...attached].some((worktree) => worktree.worktreeId === args.taskWorktreeId)
  ) {
    throw new SessionIsolationUnavailableError(
      "SESSION_ISOLATION_UNAVAILABLE: this turn's worktree is not usable by the session",
    );
  }
  const worktreeIds = [...new Set([...owned, ...attached].map((worktree) => worktree.worktreeId))]
    .sort();
  return { owned, attached, worktreeIds };
}

/**
 * 격리 계획 입력의 worktree 사실. 등록 리포는 부착 여부와 무관하게 이 노드가
 * 아는 전부를 넘겨, 같은 턴에 만든 새 워크트리도 바로 커밋할 수 있게 한다.
 */
async function collectWorktreeFacts(args: {
  worktreeService: Pick<WorktreeService, "list" | "listRepositoryIds"> | undefined;
  projectsRoot: string | undefined;
  actorSessionId: string;
  taskWorktreeId: string | undefined;
  resolveCommonDir(repositoryPath: string): Promise<string>;
}): Promise<WorktreeFacts> {
  const worktrees = await collectSessionWorktrees(args);
  const repoIds = args.worktreeService
    ? [...args.worktreeService.listRepositoryIds()].sort()
    : [];
  if (worktrees.worktreeIds.length === 0 && repoIds.length === 0) {
    return { owned: [], attached: [], repositories: [], worktreeIds: [] };
  }
  const projectsRoot = args.projectsRoot;
  if (!projectsRoot) {
    throw new SessionIsolationUnavailableError(
      "SESSION_ISOLATION_UNAVAILABLE: WORKTREE_PROJECTS_ROOT is required for worktree attachments",
    );
  }
  const commonDirectories = new Map<string, string>();
  const repositories: RegisteredRepository[] = [];
  for (const repoId of repoIds) {
    // B2가 등록 리포 경로로 resolve하는 값과 같은 입력에서 받는다.
    const canonicalPath = join(projectsRoot, repoId);
    commonDirectories.set(repoId, await args.resolveCommonDir(canonicalPath));
    repositories.push({ repoId, canonicalPath });
  }
  return {
    owned: worktrees.owned.map((worktree) => toAttachment(worktree, commonDirectories)),
    attached: worktrees.attached.map((worktree) => toAttachment(worktree, commonDirectories)),
    repositories,
    worktreeIds: worktrees.worktreeIds,
  };
}

function readWorktreeRow(row: Record<string, unknown>): SessionWorktreeRow | null {
  if (typeof row.repoId !== "string" || typeof row.path !== "string") return null;
  return {
    worktreeId: typeof row.worktreeId === "string" ? row.worktreeId : null,
    repoId: row.repoId,
    path: row.path,
    discoveryKind: typeof row.discoveryKind === "string" ? row.discoveryKind : null,
    dbState: typeof row.dbState === "string" ? row.dbState : null,
    ownerKind: typeof row.ownerKind === "string" ? row.ownerKind : null,
    ownerId: typeof row.ownerId === "string" ? row.ownerId : null,
    activeSessionId: typeof row.activeSessionId === "string" ? row.activeSessionId : null,
  };
}

function eligibleWorktree(row: SessionWorktreeRow): EligibleWorktree | null {
  if (row.worktreeId === null) return null;
  if (row.dbState !== "ready") return null;
  if (row.discoveryKind === "managed_missing") return null;
  return { worktreeId: row.worktreeId, repoId: row.repoId, path: row.path };
}

function toAttachment(
  worktree: EligibleWorktree,
  commonDirectories: ReadonlyMap<string, string>,
): WorktreeAttachment {
  const commonDir = commonDirectories.get(worktree.repoId);
  if (!commonDir) {
    throw new SessionIsolationUnavailableError(
      "SESSION_ISOLATION_UNAVAILABLE: git common directory is unresolved",
    );
  }
  return {
    id: worktree.worktreeId,
    canonicalPath: worktree.path,
    repoId: worktree.repoId,
    commonDir,
  };
}
