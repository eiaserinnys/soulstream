export type ParentEventId = string | number | null;

export type ClaudeClientEvent =
  | { type: "session"; sessionId: string; pid?: number }
  | { type: "debug"; message: string; timestamp?: number; parentEventId?: ParentEventId }
  | { type: "progress"; text: string; timestamp?: number; parentEventId?: ParentEventId }
  | { type: "text"; text: string; timestamp?: number; parentEventId?: ParentEventId }
  | {
      type: "thinking";
      thinking: string;
      signature?: string;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "tool_start";
      toolName: string;
      toolInput?: Record<string, unknown>;
      toolUseId?: string | null;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "tool_result";
      toolName?: string;
      result?: unknown;
      isError?: boolean;
      toolUseId?: string | null;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "result";
      success: boolean;
      output: string;
      error?: string | null;
      usage?: unknown;
      totalCostUsd?: number | null;
      stopReason?: string | null;
      terminalReason?: string | null;
      errors?: string[] | null;
      modelUsage?: Record<string, unknown> | null;
      permissionDenials?: string[] | null;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "context_usage";
      usedTokens: number;
      maxTokens: number;
      percent: number;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "complete";
      result?: string;
      attachments?: string[];
      claudeSessionId?: string;
      usage?: unknown;
      totalCostUsd?: number;
      model?: string;
      turnCostUsd?: number;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "error";
      message: string;
      fatal?: boolean;
      errorCode?: string;
      rateLimitType?: string;
      resetsAt?: string;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "prompt_suggestion";
      text: string;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "rate_limit";
      status?: string;
      resetsAt?: string;
      rateLimitType?: string;
      utilization?: number;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "input_request";
      requestId: string;
      toolUseId?: string | null;
      questions: unknown[];
      startedAt?: number;
      timeoutSec?: number;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "input_request_expired";
      requestId: string;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "input_request_responded";
      requestId: string;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "compact_completed";
      trigger: string;
      message: string;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "assistant_error";
      errorType: string;
      model?: string;
      messageId?: string;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "away_summary";
      content: string;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "subagent_start";
      agentId: string;
      agentType: string;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "subagent_stop";
      agentId: string;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "claude_runtime_session_state";
      state: "idle" | "running" | "requires_action";
      sessionId?: string;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "claude_runtime_task_started";
      taskId: string;
      sessionId?: string;
      toolUseId?: string;
      description?: string;
      taskType?: string;
      workflowName?: string;
      prompt?: string;
      skipTranscript?: boolean;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "claude_runtime_task_created";
      taskId: string;
      sessionId?: string;
      subject: string;
      description?: string;
      teammateName?: string;
      teamName?: string;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "claude_runtime_task_updated";
      taskId: string;
      sessionId?: string;
      patch: Record<string, unknown>;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "claude_runtime_task_progress";
      taskId: string;
      sessionId?: string;
      toolUseId?: string;
      description?: string;
      usage?: unknown;
      lastToolName?: string;
      summary?: string;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "claude_runtime_task_completed";
      taskId: string;
      sessionId?: string;
      subject: string;
      description?: string;
      teammateName?: string;
      teamName?: string;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "claude_runtime_task_notification";
      taskId: string;
      sessionId?: string;
      toolUseId?: string;
      status: "completed" | "failed" | "stopped";
      outputFile?: string;
      summary?: string;
      usage?: unknown;
      skipTranscript?: boolean;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "claude_runtime_hook_event";
      hookEventName: string;
      sessionId?: string;
      toolName?: string;
      toolUseId?: string;
      hookInput?: Record<string, unknown>;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "claude_runtime_notification";
      notificationId: string;
      source: "hook" | "system" | "tool_use";
      message: string;
      title?: string;
      notificationType?: string;
      key?: string;
      priority?: string;
      sessionId?: string;
      toolUseId?: string;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "claude_runtime_remote_trigger";
      triggerId: string;
      source: "message_origin" | "tool_use";
      sessionId?: string;
      toolUseId?: string;
      originKind?: string;
      originFrom?: string;
      originName?: string;
      originServer?: string;
      priority?: string;
      prompt?: string;
      triggerType?: string;
      payload?: Record<string, unknown>;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "claude_runtime_transcript_mirror_error";
      mirrorId: string;
      sessionId?: string;
      projectKey: string;
      transcriptSessionId: string;
      subpath?: string;
      error: string;
      timestamp?: number;
      parentEventId?: ParentEventId;
    }
  | {
      type: "claude_runtime_mode_state";
      mode: "plan" | "worktree";
      active: boolean;
      source: "hook" | "tool_use";
      sessionId?: string;
      toolName?: string;
      toolUseId?: string;
      worktreeName?: string;
      worktreePath?: string;
      worktreeAction?: string;
      timestamp?: number;
      parentEventId?: ParentEventId;
    };
