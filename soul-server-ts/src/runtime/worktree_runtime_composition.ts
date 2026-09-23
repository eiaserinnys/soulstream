import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Env } from "../config.js";
import { WorktreeHostClient } from "../control_plane/worktree_host_client.js";
import type { HostClientConfig } from "../control_plane/persistence_host_transport.js";
import { WorktreeGit } from "../worktree/worktree_git.js";
import { WORKTREE_OPERATION_TIMEOUT_MS } from "../worktree/worktree_timeouts.js";
import { RepositoryLock } from "../worktree/worktree_repository_lock.js";
import { WorktreeService } from "../worktree/worktree_service.js";

export function composeWorktreeService(
  env: Env,
  hostConfig: HostClientConfig,
  listActiveWorkspaceDirs: () => string[],
): WorktreeService | undefined {
  if (!env.WORKTREE_MCP_ENABLED) return undefined;
  const projectsRoot = env.WORKTREE_PROJECTS_ROOT;
  if (!projectsRoot) {
    throw new Error("WORKTREE_PROJECTS_ROOT is required when worktree MCP is enabled");
  }
  return new WorktreeService({
    nodeId: env.SOULSTREAM_NODE_ID,
    projectsRoot,
    git: new WorktreeGit({
      projectsRoot,
      timeoutMs: WORKTREE_OPERATION_TIMEOUT_MS,
      createTimeoutMs: env.WORKTREE_CREATE_TIMEOUT_MS,
    }),
    createTimeoutMs: env.WORKTREE_CREATE_TIMEOUT_MS,
    lock: new RepositoryLock({
      lockRoot: join(tmpdir(), "soulstream-worktree-locks"),
      defaultTimeoutMs: 120_000,
    }),
    host: new WorktreeHostClient(hostConfig),
    listActiveWorkspaceDirs,
  });
}

export async function resolveWorktreeWorkspace(
  service: WorktreeService | undefined,
  worktreeId: string,
): Promise<string> {
  if (!service) {
    throw new Error(`WORKTREE_UNAVAILABLE: resolver missing for ${worktreeId}`);
  }
  return await service.resolveExecutionWorkspace(worktreeId);
}
