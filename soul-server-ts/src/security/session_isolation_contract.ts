import type { ChildProcess, SpawnOptions } from "node:child_process";

import type { ResolvedMcpServer } from "../mcp_config_service.js";

export type { ResolvedMcpServer } from "../mcp_config_service.js";

/** `full`은 기존 권한 그대로, `restricted`만 격리 실행기(B1/B2)로 보낸다. */
export type ExecutionTier = "full" | "restricted";

export type ExecutionDecisionReason =
  | "trusted"
  | "untrusted-preset"
  | "inherited"
  | "unresolved-ancestry"
  | "windows";

/**
 * 세션 턴 실행의 보안 판정. 세션마다 하나이며, 계보는 이 결정을 다시
 * 계산하지 않고 호출자 결정을 상속한다.
 */
export interface ExecutionSecurityDecision {
  sessionId: string;
  tier: ExecutionTier;
  policyVersion: 1;
  reason: ExecutionDecisionReason;
  presetId: string | null;
}

/** restricted 세션이 받을 수 있는 자격 증명의 종류. 값이 아니라 종류만 담는다. */
export type RestrictedAuthKind =
  | "codex-grant"
  | "claude-oauth-token"
  | "apikey-env"
  | "unavailable";

/** 내부 MCP가 보는 세션의 신원. 토큰 원문은 담지 않는다. */
export type McpPrincipal =
  | { tier: "full" }
  | { tier: "restricted"; sessionId: string };

export type IsolationBackend = "claude" | "codex" | "opencode" | "antigravity";

export interface MountBinding {
  source: string;
  destination: string;
  writable: boolean;
}

export type IsolationMask = {
  path: string;
  kind: "file" | "directory";
};

/**
 * B2가 만드는 격리 실행 명세. 값에는 비밀을 담지 않으며, 환경변수는
 * `PreparedIsolationPlan.env`와 `IsolationLaunchInput.env`에만 존재한다.
 */
export interface SessionIsolationSpec {
  version: 1;
  enabled: boolean;
  sessionId: string;
  backend: IsolationBackend;
  workspaceDir: string;
  scratchWorkspaceDir: string;
  sandboxDirectory: string;
  sessionWorktreeRoot: string;
  authKind: RestrictedAuthKind;
  policyDigest: string;
  bindings: MountBinding[];
  masks: IsolationMask[];
  /** heavy-work-lock 4개 슬롯 파일의 정확한 read/write bind. */
  heavyWorkLockBindings: MountBinding[];
  hostProcLocksBinding: MountBinding;
  approvedLocalMcp: {
    serverId: string;
    hostPort: number;
    sandboxPort: number;
  }[];
  approvedTestDatabase: {
    hostPort: number;
    sandboxPort: number;
  } | null;
}

/**
 * 호스트가 준비한 restricted 인증 재료. 토큰 원문이 아니라 경로와
 * 식별자만 담고, 실제 값은 B1이 만든 자식 환경에만 넣는다.
 */
export interface IsolatedAuthPreparation {
  kind: RestrictedAuthKind;
  credentialAccountId?: string;
  canonicalCodexDirectory?: string;
  claudeTokenFile?: string;
}

export type IsolationToolGuard =
  | "draft-card"
  | "card-status"
  | "worktree-create"
  | "owned-worktree"
  | "message-recipient"
  | "create-local-session";

export type IsolationToolPolicy =
  | { category: "allow" }
  | { category: "deny" }
  | {
    category: "guarded";
    guard: Exclude<IsolationToolGuard, "create-local-session">;
  }
  | { category: "inherit"; guard: "create-local-session" };

/** 정책 파일에서 읽는 고정 정책. digest는 이 값에서 계산한다. */
export interface IsolationPolicy {
  version: 1;
  tools: Record<string, IsolationToolPolicy>;
  localMcp: {
    requiredServerId: "soulstream";
    optional: { serverId: string; nodeId: string; port: number }[];
  };
  filesystem: {
    sessionWorktreeRelativeRoot: ".projects/.isolated";
    credentialRelativeDirectory: ".local/share/soulstream/credentials/codex";
    isolatedCacheRelativeRoot: ".local/share/soulstream/isolated-cache";
    writableWorkspaceRelativeDirectories: [".local/tmp", ".local/artifacts"];
    /** 노드별 실제 경로, 비밀 값 없음. */
    additionalSensitiveRoots: string[];
  };
  testDatabases: { nodeId: string; hostPort: number; sandboxPort: number }[];
  network: {
    mode: "pasta-nft";
    dnsForward4: "192.0.2.53";
    deniedIpv4: string[];
    deniedIpv6: string[];
  };
}

/** 관측 도구 정책(§5). `include_logs`일 때만 `service`가 필요하다. */
export interface ObservationOptions {
  service?: string;
  include_logs?: boolean;
  lines?: number;
  include_pending?: boolean;
}

export interface SessionCommand {
  command: string;
  args: readonly string[];
}

/** 이 세션이 소유한 워크트리. worktree 레코드의 구조적 부분집합이다. */
export interface WorktreeAttachment {
  id: string;
  canonicalPath: string;
  repoId: string;
  commonDir: string;
}

/** 세션에 연결된 등록 리포. */
export interface RegisteredRepository {
  repoId: string;
  canonicalPath: string;
}

/** B2 입력. `testDatabaseUrl`은 메모리에서만 쓰고 직렬화하지 않는다. */
export interface IsolationPreparationInput {
  decision: ExecutionSecurityDecision;
  backend: IsolationBackend;
  workspaceDir: string;
  sessionDirectory: string;
  hostWorkspaceRoot: string;
  homeDirectory: string;
  uid: number;
  policy: IsolationPolicy;
  policyDigest: string;
  resolvedServers: readonly ResolvedMcpServer[];
  actualInternalMcpUrl: string;
  ownedWorktrees: readonly WorktreeAttachment[];
  attachedWorktrees: readonly WorktreeAttachment[];
  registeredRepositories: readonly RegisteredRepository[];
  authPreparation: IsolatedAuthPreparation;
  testDatabaseUrl?: string;
  scratchWorkspaceDir: string;
}

/** B2 출력. `env`만 비밀을 담을 수 있고 프레임과 러너 설정으로 나가지 않는다. */
export interface PreparedIsolationPlan {
  spec: SessionIsolationSpec;
  sanitizedServers: readonly ResolvedMcpServer[];
  env: Record<string, string>;
  resolvConfPath: string;
  contextNotice: string;
}

/** B1 입력. `env`는 원본 세션 환경이며 합성은 B1이 한다. */
export interface IsolationLaunchInput {
  original: SessionCommand;
  plan: SessionIsolationSpec;
  resolvConfPath: string;
  cwd: string;
  env: Record<string, string>;
  stdio: SpawnOptions["stdio"];
  signal?: AbortSignal;
  tools: {
    bwrap: string;
    pasta: string;
    unshare: string;
    setpriv: string;
    nft: string;
    netnsHelper: string;
  };
}

export interface IsolationLaunchResult {
  child: ChildProcess;
  ready: Promise<void>;
  completion: Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>;
  dispose: () => Promise<void>;
}

/** B2 계약. 호스트 부수효과는 주입된 포트로만 일으킨다. */
export type PrepareIsolationPlan = (
  input: IsolationPreparationInput,
  ports: IsolationHostPorts,
) => Promise<PreparedIsolationPlan>;

/** B1 계약. 프로세스 생성·종료는 주입된 포트로만 일으킨다. */
export type LaunchIsolatedSession = (
  input: IsolationLaunchInput,
  ports: IsolationProcessPorts,
) => IsolationLaunchResult;

/** off 플랜에서는 원본 argv를 그대로 돌려준다. */
export type WrapSessionCommand = (
  original: SessionCommand,
  plan: SessionIsolationSpec,
) => SessionCommand;

/** 경로 자체의 상태. 심볼릭 링크는 따라가지 않는다. */
export interface HostPathFact {
  kind: "file" | "directory" | "symlink" | "other";
  dev: number;
  ino: number;
  /** 하드링크 수. 1이면 다른 경로와 inode를 공유하지 않는다. */
  nlink: number;
}

export interface HostDirectoryEntry {
  name: string;
  kind: HostPathFact["kind"];
}

/** B2가 쓰는 호스트 부수효과 포트. */
export interface IsolationHostPorts {
  ensureDirectory(path: string, mode: number): Promise<void>;
  writeFile(path: string, contents: string, mode: number): Promise<void>;
  copyFile(source: string, destination: string, mode: number): Promise<void>;
  /** bind 원본의 정규 절대 경로. 존재하지 않으면 거절한다. */
  resolveRealPath(path: string): Promise<string>;
  /** 인증 재료가 실제로 있는지 확인한다. 토큰 원문은 읽지 않는다. */
  verifyAuthPreparation(preparation: IsolatedAuthPreparation): Promise<void>;
  /** restricted 자식에게 줄 GH 자격 증명 환경. 메모리에서만 쓴다. */
  prepareGitHubCredential(): Promise<Record<string, string>>;
  /** 내부 MCP용 세션 범위 자격 증명. 메모리에서만 쓴다. */
  issueRestrictedCredential(sessionId: string): Promise<string>;
  /** 허용 목록 밖 로컬 MCP를 제거하고 승인 포트를 샌드박스 포트로 바꾼다. */
  sanitizeMcpServers(
    servers: readonly ResolvedMcpServer[],
    policy: IsolationPolicy,
  ): Promise<readonly ResolvedMcpServer[]>;
  /** 메타데이터만 읽는다. 파일 내용(비밀)은 읽지 않는다. 없으면 null. */
  lstatPath(path: string): Promise<HostPathFact | null>;
  /** 이름과 종류만 읽는다. 파일 내용은 읽지 않는다. */
  listDirectory(path: string): Promise<HostDirectoryEntry[]>;
  /** 링크 대상 경로만 읽는다. 대상 파일의 내용은 읽지 않는다. */
  readSymlink(path: string): Promise<string | null>;
  /** 커널 표식만 확인한다. 입력이나 헤더로 바꿀 수 없다. */
  detectWsl(): Promise<boolean>;
  /** 기존 내용을 자르지 않고 lock 파일을 연다. 일반 파일이 아니면 거절한다. */
  ensureLockFile(path: string, mode: number): Promise<void>;
  /** 링크만 만든다. 대상 파일의 내용은 읽지 않는다. */
  ensureSymlink(target: string, path: string): Promise<void>;
  /** 파일 내용을 SHA-512로 요약한다. 원문은 돌려주지 않는다. */
  hashFileSha512(path: string): Promise<string>;
  /** git common 디렉터리의 절대 경로만 조회한다. 파일 내용은 읽지 않는다. */
  resolveGitCommonDir(repositoryPath: string): Promise<string>;
  /** 이 노드의 식별자만 조회한다. 비밀을 읽지 않는다. */
  resolveNodeId(): Promise<string>;
  /** pnpm 주 저장소 경로만 조회한다. 없으면 null. 비밀을 읽지 않는다. */
  resolveMainPackageStorePath(): Promise<string | null>;
  /**
   * 제한 세션에 줄 Claude OAuth 토큰. 다른 파일 내용은 읽지 않으며,
   * 토큰은 메모리에서만 쓰고 로그·직렬화에 넣지 않는다.
   */
  readClaudeOauthToken(): Promise<string>;
  /** 공통 파일 디렉터리 경로만 조회한다. 내용(비밀)은 읽지 않는다. */
  resolveAgentCommonFilesDirectory(): Promise<string | null>;
  /**
   * 서버 dotenv가 `.env.soul-server-ts`를 읽는 디렉터리 경로만 조회한다.
   * env 파일 내용(비밀)은 읽지 않는다. 없으면 null.
   */
  resolveServiceEnvironmentDirectory(): Promise<string | null>;
}

/** B1이 쓰는 프로세스 포트. 실제 프로세스를 다루는 곳은 이 어댑터뿐이다. */
export interface IsolationProcessPorts {
  spawn(input: {
    command: string;
    args: readonly string[];
    options: SpawnOptions;
  }): ChildProcess;
  /** netns 헬퍼가 nft·라우트·bind 준비를 마쳤다고 알릴 때 완료된다. */
  awaitNetworkReady(child: ChildProcess): Promise<void>;
  /** 이 실행이 소유한 프로세스만 해제한다. `pid`는 검증된 양의 정수다. */
  kill(pid: number, signal: NodeJS.Signals): boolean;
}
