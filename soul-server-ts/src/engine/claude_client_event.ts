export type ClaudeClientEvent =
  | { type: "session"; sessionId: string; pid?: number }
  | { type: "debug"; message: string; timestamp?: number }
  | {
      type: "progress";
      text: string;
      foregroundToolUseId?: string;
      timestamp?: number;
    }
  | { type: "text"; text: string; timestamp?: number }
  | {
      type: "thinking";
      thinking: string;
      signature?: string;
      timestamp?: number;
    }
  | {
      type: "tool_start";
      toolName: string;
      toolInput?: Record<string, unknown>;
      toolUseId?: string | null;
      timestamp?: number;
    }
  | {
      type: "tool_result";
      toolName?: string;
      result?: unknown;
      isError?: boolean;
      toolUseId?: string | null;
      timestamp?: number;
    }
  | {
      type: "result";
      success: boolean;
      output: string;
      error?: string | null;
      usage?: unknown;
      model?: string;
      turnCostUsd?: number;
      firstCall?: { inputTokens: number; cachedInputTokens: number };
      totalCostUsd?: number | null;
      stopReason?: string | null;
      terminalReason?: string | null;
      errors?: string[] | null;
      modelUsage?: Record<string, unknown> | null;
      permissionDenials?: string[] | null;
      timestamp?: number;
    }
  | {
      type: "context_usage";
      usedTokens: number;
      maxTokens: number;
      percent: number;
      timestamp?: number;
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
      firstCall?: { inputTokens: number; cachedInputTokens: number };
      timestamp?: number;
    }
  | {
      type: "error";
      message: string;
      fatal?: boolean;
      errorCode?: string;
      rateLimitType?: string;
      resetsAt?: string;
      timestamp?: number;
    }
  | {
      type: "prompt_suggestion";
      text: string;
      timestamp?: number;
    }
  | {
      type: "rate_limit";
      status?: string;
      resetsAt?: string;
      rateLimitType?: string;
      utilization?: number;
      timestamp?: number;
    }
  | {
      type: "input_request";
      requestId: string;
      toolUseId?: string | null;
      questions: unknown[];
      startedAt?: number;
      timeoutSec?: number;
      timestamp?: number;
    }
  | {
      type: "input_request_expired";
      requestId: string;
      timestamp?: number;
    }
  | {
      type: "input_request_responded";
      requestId: string;
      timestamp?: number;
    }
  | {
      type: "compact_completed";
      trigger: string;
      message: string;
      timestamp?: number;
    }
  | {
      type: "assistant_error";
      errorType: string;
      model?: string;
      messageId?: string;
      timestamp?: number;
    }
  | {
      type: "away_summary";
      content: string;
      timestamp?: number;
    }
  | {
      type: "subagent_start";
      agentId: string;
      agentType: string;
      timestamp?: number;
    }
  | {
      type: "subagent_stop";
      agentId: string;
      timestamp?: number;
    }
  | {
      type: "claude_runtime_session_state";
      state: "idle" | "running" | "requires_action";
      sessionId?: string;
      timestamp?: number;
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
    }
  | {
      type: "claude_runtime_task_updated";
      taskId: string;
      sessionId?: string;
      patch: Record<string, unknown>;
      timestamp?: number;
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
    }
  | {
      type: "claude_runtime_hook_event";
      hookEventName: string;
      sessionId?: string;
      toolName?: string;
      toolUseId?: string;
      hookInput?: Record<string, unknown>;
      timestamp?: number;
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
    };
