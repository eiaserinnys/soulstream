export type WorktreeState = "ready" | "removing" | "removed";
export type WorktreeSetupMode = "none" | "shared_dependencies";
export type WorktreeSetupStatus = "not_requested" | "ready" | "failed";

export interface ManagedWorktreePath {
  path: string;
  target: string;
}

export interface WorktreeRecord {
  id: string;
  nodeId: string;
  repoId: string;
  canonicalPath: string;
  branch: string;
  createdFromSha: string;
  ownerFolderId: string | null;
  createdBySessionId: string;
  state: WorktreeState;
  setupMode: WorktreeSetupMode;
  setupRequired: boolean;
  setupStatus: WorktreeSetupStatus;
  managedPaths: ManagedWorktreePath[];
  worktreeIdentity: string;
  branchDeleteExpectedSha: string | null;
  branchDeleteMarkerRef: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt?: string;
  updatedAt?: string;
  removedAt?: string | null;
  branchDeletedAt?: string | null;
  mutableByCaller?: boolean;
  activeSessionId?: string | null;
}

export interface WorktreeMutationActor {
  actorSessionId: string;
}

export type WorktreeRemovalActor = WorktreeMutationActor | { sweeperNodeId: string };

export interface WorktreeSweepCandidate extends WorktreeRecord {
  lastSessionActivityAt: string | Date;
  linkedCardsClosed: boolean;
}

export interface WorktreeHost {
  sweepCandidates(input: { nodeId: string }): Promise<WorktreeSweepCandidate[]>;
  list(input: {
    actorSessionId: string;
    nodeId: string;
    repoId?: string;
    worktreeId?: string;
  }): Promise<WorktreeRecord[]>;
  register(input: {
    actorSessionId: string;
    id: string;
    nodeId: string;
    repoId: string;
    canonicalPath: string;
    branch: string;
    createdFromSha: string;
    setupMode: WorktreeSetupMode;
    setupRequired: boolean;
    setupStatus: WorktreeSetupStatus;
    managedPaths: ManagedWorktreePath[];
    worktreeIdentity: string;
  }): Promise<WorktreeRecord>;
  updateSetup(input: WorktreeMutationActor & {
    worktreeId: string;
    setupStatus: WorktreeSetupStatus;
    managedPaths: ManagedWorktreePath[];
  }): Promise<WorktreeRecord>;
  beginRemove(input: WorktreeRemovalActor & {
    worktreeId: string;
    expectedSha: string | null;
  }): Promise<WorktreeRecord>;
  restoreReady(input: WorktreeRemovalActor & {
    worktreeId: string;
    errorCode: string;
    errorMessage: string;
  }): Promise<WorktreeRecord>;
  finishRemove(input: WorktreeRemovalActor & { worktreeId: string }): Promise<WorktreeRecord>;
  beginBranchDelete(input: WorktreeMutationActor & {
    worktreeId: string;
    expectedSha: string;
    markerRef: string;
  }): Promise<WorktreeRecord>;
  finishBranchDelete(input: WorktreeMutationActor & { worktreeId: string }): Promise<WorktreeRecord>;
  resolveExecution(input: {
    worktreeId: string;
    nodeId: string;
  }): Promise<WorktreeRecord>;
}
