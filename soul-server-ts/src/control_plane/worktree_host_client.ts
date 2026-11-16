import {
  PersistenceHostTransport,
  requestHostOperationWithRetry,
  SESSION_START_RESTART_WINDOW,
  type HostClientConfig,
  type RestartWindowRetryPolicy,
} from "./persistence_host_transport.js";
import type {
  WorktreeHost,
  WorktreeListOptions,
  WorktreeRecord,
  WorktreeSweepCandidate,
} from "../worktree/worktree_types.js";

export class WorktreeHostClient implements WorktreeHost {
  private readonly transport: PersistenceHostTransport;
  private readonly logger: HostClientConfig["logger"];

  constructor(config: HostClientConfig) {
    this.transport = new PersistenceHostTransport(config);
    this.logger = config.logger;
  }

  /**
   * The isolation gate refuses the session start when this read fails, so a
   * busy host or a stalled node must cost latency, not the start (card #1178).
   * The isolation inventory caller additionally opts into the restart-window
   * schedule so an orchestrator restart does not refuse the start (card #1350).
   */
  list(
    input: Parameters<WorktreeHost["list"]>[0],
    options: WorktreeListOptions = {},
  ): Promise<WorktreeRecord[]> {
    const restartWindow: RestartWindowRetryPolicy | undefined =
      options.restartWindow === true
        ? {
            ...SESSION_START_RESTART_WINDOW,
            onRetry: (event) => {
              this.logger.warn(
                { read: "isolation_worktree_list", operation: "list", ...event },
                "session-start worktree list retrying while the host restarts",
              );
            },
            onRecovered: (event) => {
              this.logger.info(
                { read: "isolation_worktree_list", operation: "list", ...event },
                "session-start worktree list recovered after a host restart",
              );
            },
          }
        : undefined;
    return requestHostOperationWithRetry<WorktreeRecord[]>(
      this.transport,
      "worktrees",
      "list",
      [input],
      { timeoutMs: 5_000, attempts: 3, retryDelaysMs: [250, 1_000], restartWindow },
    );
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
