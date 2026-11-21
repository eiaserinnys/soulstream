import type {
  ClaudeBackgroundTaskGenerationRow,
  ObserveClaudeBackgroundTaskGenerationParams,
  ResolveClaudeBackgroundTaskGenerationResult,
  TerminalizeClaudeBackgroundTaskGenerationParams,
  TerminalizeClaudeBackgroundTaskGenerationResult,
} from "@soulstream/mcp-contract";
import {
  ORCH_HOST_REQUEST_TIMEOUT_MS,
  requestHostOperationWithRetry,
  type PersistenceHostTransport,
} from "./persistence_host_transport.js";

export const CLAUDE_BACKGROUND_GENERATION_RETRY_DELAYS_MS = [
  500, 1_000, 2_000, 4_000, 8_000, 12_000, 15_000, 15_000, 15_000, 15_000,
] as const;

export class ClaudeBackgroundGenerationHostClient {
  constructor(
    private readonly transport: PersistenceHostTransport,
    private readonly retryDelaysMs: readonly number[] =
      CLAUDE_BACKGROUND_GENERATION_RETRY_DELAYS_MS,
  ) {}

  /** A failed observation is swallowed by the caller, but the turn still waits for it. */
  observe(params: ObserveClaudeBackgroundTaskGenerationParams) {
    return requestHostOperationWithRetry<ClaudeBackgroundTaskGenerationRow>(
      this.transport, "claude-runtime", "observe_background_generation", [params],
      {
        timeoutMs: 2_000,
        attempts: this.retryDelaysMs.length + 1,
        retryDelaysMs: this.retryDelaysMs,
      },
    );
  }

  terminalize(params: TerminalizeClaudeBackgroundTaskGenerationParams) {
    return requestHostOperationWithRetry<TerminalizeClaudeBackgroundTaskGenerationResult>(
      this.transport, "claude-runtime", "terminalize_background_generation", [params],
      {
        timeoutMs: ORCH_HOST_REQUEST_TIMEOUT_MS,
        attempts: this.retryDelaysMs.length + 1,
        retryDelaysMs: this.retryDelaysMs,
      },
    );
  }

  get(sourceNode: string, sessionId: string, sdkSessionId: string, taskId: string,
    initiatingToolUseId: string) {
    return this.transport.request<ClaudeBackgroundTaskGenerationRow | null>(
      "claude-runtime", "get_background_generation",
      [sourceNode, sessionId, sdkSessionId, taskId, initiatingToolUseId],
    );
  }

  activeForNode(params: { sourceNode: string; updatedBefore: Date; limit: number }) {
    return this.transport.request<ClaudeBackgroundTaskGenerationRow[]>(
      "claude-runtime", "active_background_generations_for_node", [params],
    );
  }

  activeForExecution(sourceNode: string, sessionId: string,
    runnerRegistrationId: string, executionCommandId: string, limit = 1_000) {
    return this.transport.request<ClaudeBackgroundTaskGenerationRow[]>(
      "claude-runtime", "active_background_generations_for_execution",
      [sourceNode, sessionId, runnerRegistrationId, executionCommandId, limit],
    );
  }

  /** The resolve read has no side effects, so a lost response is safe to retry. */
  resolve(sourceNode: string, sessionId: string, sdkSessionId: string, taskId: string) {
    return requestHostOperationWithRetry<ResolveClaudeBackgroundTaskGenerationResult>(
      this.transport, "claude-runtime", "resolve_background_generation",
      [sourceNode, sessionId, sdkSessionId, taskId],
      {
        timeoutMs: ORCH_HOST_REQUEST_TIMEOUT_MS,
        attempts: this.retryDelaysMs.length + 1,
        retryDelaysMs: this.retryDelaysMs,
      },
    );
  }
}
