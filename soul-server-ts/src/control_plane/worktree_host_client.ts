import { PersistenceHostTransport, type HostClientConfig } from "./persistence_host_transport.js";
import type { WorktreeHost, WorktreeRecord, WorktreeSweepCandidate } from "../worktree/worktree_types.js";

export class WorktreeHostClient implements WorktreeHost {
  private readonly transport: PersistenceHostTransport;

  constructor(config: HostClientConfig) {
    this.transport = new PersistenceHostTransport(config);
  }

  list(input: Parameters<WorktreeHost["list"]>[0]): Promise<WorktreeRecord[]> {
    return this.request("list", input);
  }

  sweepCandidates(input: Parameters<WorktreeHost["sweepCandidates"]>[0]): Promise<WorktreeSweepCandidate[]> {
    return this.request("sweep_candidates", input);
  }

  register(input: Parameters<WorktreeHost["register"]>[0]): Promise<WorktreeRecord> {
    return this.request("register", input);
  }

  updateSetup(input: Parameters<WorktreeHost["updateSetup"]>[0]): Promise<WorktreeRecord> {
    return this.request("update_setup", input);
  }

  beginRemove(input: Parameters<WorktreeHost["beginRemove"]>[0]): Promise<WorktreeRecord> {
    return this.request("begin_remove", input);
  }

  restoreReady(input: Parameters<WorktreeHost["restoreReady"]>[0]): Promise<WorktreeRecord> {
    return this.request("restore_ready", input);
  }

  finishRemove(input: Parameters<WorktreeHost["finishRemove"]>[0]): Promise<WorktreeRecord> {
    return this.request("finish_remove", input);
  }

  beginBranchDelete(input: Parameters<WorktreeHost["beginBranchDelete"]>[0]): Promise<WorktreeRecord> {
    return this.request("begin_branch_delete", input);
  }

  finishBranchDelete(input: Parameters<WorktreeHost["finishBranchDelete"]>[0]): Promise<WorktreeRecord> {
    return this.request("finish_branch_delete", input);
  }

  resolveExecution(input: Parameters<WorktreeHost["resolveExecution"]>[0]): Promise<WorktreeRecord> {
    return this.request("resolve_execution", input);
  }

  private request<T>(operation: string, input: object): Promise<T> {
    return this.transport.request("worktrees", operation, [input]);
  }
}
