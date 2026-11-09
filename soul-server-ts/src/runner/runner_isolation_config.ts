import { z } from "zod";

import type { SessionIsolationSpec } from "../security/session_isolation_contract.js";
import type { RunnerIsolationIdentity } from "../security/session_isolation_turn.js";

/**
 * 러너 자식 설정에 들어가는 격리 부분. 값·경로·키 이름만 담고 비밀은
 * 담지 않는다(`PreparedIsolationPlan.env`는 호스트가 자식 프로세스 환경으로만
 * 넘긴다).
 */

const MountBindingSchema = z.object({
  source: z.string().min(1),
  destination: z.string().min(1),
  writable: z.boolean(),
});

const IsolationMaskSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(["file", "directory"]),
});

export const SessionIsolationSpecSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  sessionId: z.string().min(1),
  backend: z.enum(["claude", "codex", "opencode", "antigravity"]),
  workspaceDir: z.string().min(1),
  scratchWorkspaceDir: z.string().min(1),
  sandboxDirectory: z.string().min(1),
  sessionWorktreeRoot: z.string().min(1),
  authKind: z.enum(["codex-grant", "claude-oauth-token", "apikey-env", "unavailable"]),
  policyDigest: z.string().min(1),
  bindings: z.array(MountBindingSchema),
  masks: z.array(IsolationMaskSchema),
  heavyWorkLockBindings: z.array(MountBindingSchema),
  hostProcLocksBinding: MountBindingSchema,
  approvedLocalMcp: z.array(z.object({
    serverId: z.string().min(1),
    hostPort: z.number().int().positive(),
    sandboxPort: z.number().int().positive(),
  })),
  approvedTestDatabase: z.object({
    hostPort: z.number().int().positive(),
    sandboxPort: z.number().int().positive(),
  }).nullable(),
});

// 스키마가 계약 필드를 하나라도 빠뜨리면 이 대입이 컴파일되지 않는다.
const sessionIsolationSpecContractCheck: SessionIsolationSpec =
  {} as z.infer<typeof SessionIsolationSpecSchema>;
void sessionIsolationSpecContractCheck;

export const RunnerIsolationChildConfigSchema = z.object({
  spec: SessionIsolationSpecSchema,
  resolvConfPath: z.string().min(1),
  wsl: z.boolean(),
  tools: z.object({
    bwrap: z.string().min(1),
    pasta: z.string().min(1),
    unshare: z.string().min(1),
    setpriv: z.string().min(1),
    nft: z.string().min(1),
    netnsHelper: z.string().min(1),
  }),
  /** 자식 프로세스 환경에서 CLI 환경으로 옮길 키 이름. 값은 담지 않는다. */
  envKeys: z.array(z.string().min(1)),
  contextNotice: z.string().min(1),
  attachedWorktreeIds: z.array(z.string().min(1)),
});

export type RunnerIsolationChildConfig = z.infer<typeof RunnerIsolationChildConfigSchema>;

/** 보관된 자식 설정에서 이 러너의 격리 신원을 복원한다. */
export function runnerIsolationIdentityFromConfig(
  isolation: RunnerIsolationChildConfig | undefined,
): RunnerIsolationIdentity | undefined {
  if (!isolation) return undefined;
  return {
    tier: "restricted",
    policyDigest: isolation.spec.policyDigest,
    attachedWorktreeIds: [...isolation.attachedWorktreeIds].sort(),
  };
}
