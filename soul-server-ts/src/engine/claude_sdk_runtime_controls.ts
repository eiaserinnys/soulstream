import type { Query as ClaudeSdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import type { RunnerControlFrame } from "../runner/frame_protocol.js";
import type { ClaudeRunOptions } from "./claude_adapter.js";
import type { ClaudeBackgroundTaskControlResult, EngineUserInput } from "./protocol.js";
import type { ClaudeSdkPersistentSession } from "./claude_sdk_persistent_session.js";
import type { ClaudeSdkToolPermissionController } from "./claude_sdk_tool_permissions.js";
import type { ClaudePersistentRuntimeActivity } from "./claude_session_runtime.js";
import type { ClaudeRuntimeState } from "./claude_sdk_runtime_state.js";

export interface ClaudeSdkRuntimeControlsOptions {
  logger: Logger;
  runtimeState: ClaudeRuntimeState;
  toolPermissionController: ClaudeSdkToolPermissionController;
  activeQuery(): ClaudeSdkQuery | null;
  persistentSession(): ClaudeSdkPersistentSession | null;
  lastRunOptions(): ClaudeRunOptions | null;
  closePersistentAndSettle(
    persistent: ClaudeSdkPersistentSession,
    reason: import("./claude_session_runtime.js").ClaudeRuntimeCloseReason,
  ): Promise<void>;
  waitForChildExit(): Promise<void>;
}

export class ClaudeSdkRuntimeControls {
  constructor(private readonly options: ClaudeSdkRuntimeControlsOptions) {}

  sendControlFrame(frame: RunnerControlFrame): boolean {
    if (frame.kind !== "input_response") return false;
    return this.options.toolPermissionController.deliverInputResponse(
      frame.correlationId,
      frame.answers,
    );
  }

  persistentRuntimeActivity(): ClaudePersistentRuntimeActivity | null {
    const snapshot = this.options.persistentSession()?.snapshot();
    if (!snapshot) return null;
    return {
      foregroundPhase: snapshot.foregroundPhase,
      queryLifecycle: snapshot.queryLifecycle,
      backgroundTaskCount: snapshot.backgroundTaskIds.length,
      pendingInputRequestCount:
        this.options.toolPermissionController.pendingInputRequestCount(),
      pendingRuntimeSignalCount:
        (this.options.runtimeState.hasPendingWork() ? 1 : 0) +
        this.options.persistentSession()!.pendingNativeNotificationCount(),
    };
  }

  injectAtToolBoundary(input: EngineUserInput): boolean {
    return this.options.persistentSession()?.injectAtToolBoundary(input) ?? false;
  }

  async backgroundClaudeRuntimeTasks(
    toolUseId?: string,
  ): Promise<ClaudeBackgroundTaskControlResult> {
    const query = this.options.activeQuery();
    if (!query) {
      return {
        status: "no_active_query",
        message: "No active Claude SDK query",
      };
    }
    try {
      const backgrounded = await query.backgroundTasks(toolUseId);
      if (!backgrounded) {
        return {
          status: "no_match",
          message: toolUseId
            ? `No foreground Claude task matched toolUseId: ${toolUseId}`
            : "No foreground Claude task was backgrounded",
        };
      }
      return { status: "ok" };
    } catch (err) {
      return {
        status: "failed",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async stopClaudeRuntimeTask(taskId: string): Promise<ClaudeBackgroundTaskControlResult> {
    const query = this.options.activeQuery();
    if (!query) {
      return {
        status: "no_active_query",
        message: "No active Claude SDK query",
      };
    }
    try {
      await query.stopTask(taskId);
      const persistent = this.options.persistentSession();
      if (this.options.lastRunOptions()?.trackChildExit && persistent) {
        await this.options.closePersistentAndSettle(persistent, "explicit_cancel");
      }
      return { status: "ok" };
    } catch (err) {
      return {
        status: "failed",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async interrupt(): Promise<boolean> {
    const persistent = this.options.persistentSession();
    if (persistent) {
      await this.options.closePersistentAndSettle(persistent, "explicit_cancel");
      this.options.toolPermissionController.abortPendingInputRequests();
      return true;
    }
    const query = this.options.activeQuery();
    if (!query) return false;
    try {
      await query.interrupt();
    } catch (err) {
      this.options.logger.warn({ err }, "Claude SDK interrupt failed; closing query");
      query.close();
    }
    this.options.toolPermissionController.abortPendingInputRequests();
    return true;
  }

  async interruptActiveTurnForSteer(): Promise<boolean> {
    const persistent = this.options.persistentSession();
    if (persistent) {
      const observation = persistent.interruptForeground();
      this.options.toolPermissionController.abortPendingInputRequests();
      const interrupted = await observation;
      if (
        this.options.lastRunOptions()?.trackChildExit
        && this.options.persistentSession()?.snapshot().queryLifecycle !== "open"
      ) {
        await this.options.waitForChildExit();
      }
      return interrupted;
    }
    const query = this.options.activeQuery();
    if (!query) return false;
    try {
      await query.interrupt();
    } catch (err) {
      this.options.logger.warn({ err }, "Claude SDK steer interrupt failed");
      return false;
    }
    this.options.toolPermissionController.abortPendingInputRequests();
    return true;
  }
}
