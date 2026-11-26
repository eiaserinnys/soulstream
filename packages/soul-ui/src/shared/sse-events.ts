import type {
  SSEEventAssistantError,
  SSEEventAssistantMessage,
  SSEEventAwaySummary,
  SSEEventClaudeRuntimeHookEvent,
  SSEEventClaudeRuntimeModeState,
  SSEEventClaudeRuntimeNotification,
  SSEEventClaudeRuntimeRemoteTrigger,
  SSEEventClaudeRuntimeScheduleDeleted,
  SSEEventClaudeRuntimeScheduleUpdated,
  SSEEventClaudeRuntimeSessionState,
  SSEEventClaudeRuntimeTaskCompleted,
  SSEEventClaudeRuntimeTaskCreated,
  SSEEventClaudeRuntimeTaskNotification,
  SSEEventClaudeRuntimeTaskProgress,
  SSEEventClaudeRuntimeTaskStarted,
  SSEEventClaudeRuntimeTaskUpdated,
  SSEEventClaudeRuntimeTranscriptMirrorError,
  SSEEventCompact,
  SSEEventComplete,
  SSEEventContextManifest,
  SSEEventContextUsage,
  SSEEventCredentialAlert,
  SSEEventCustomViewUpdated,
  SSEEventDebug,
  SSEEventError,
  SSEEventFolderUpdated,
  SSEEventGenerationStarted,
  SSEEventHistorySync,
  SSEEventInputMaterialManifest,
  SSEEventInputRequest,
  SSEEventInputRequestExpired,
  SSEEventInputRequestResponded,
  SSEEventInterventionSent,
  SSEEventProgress,
  SSEEventPromptSuggestion,
  SSEEventReportTimeline,
  SSEEventReportTimelineQuestionClosed,
  SSEEventResult,
  SSEEventSession,
  SSEEventSessionEnded,
  SSEEventSessionNotification,
  SSEEventSubagentStart,
  SSEEventSubagentStop,
  SSEEventSystemMessage,
  SSEEventTextDelta,
  SSEEventTextEnd,
  SSEEventTextSnapshot,
  SSEEventTextStart,
  SSEEventThinking,
  SSEEventToolApprovalRequested,
  SSEEventToolApprovalResolved,
  SSEEventToolResult,
  SSEEventToolStart,
  SSEEventTurnSummary,
  SSEEventUsageObservation,
  SSEEventUserMessage,
} from "../../../wire-schema";

export type ProgressEvent = SSEEventProgress;
export type SessionEvent = SSEEventSession;
export type InterventionSentEvent = SSEEventInterventionSent;
export type SessionNotificationEvent = SSEEventSessionNotification;
export type UserMessageEvent = SSEEventUserMessage;
export type DebugEvent = SSEEventDebug;
export type AssistantErrorEvent = SSEEventAssistantError;
export type CredentialAlertEvent = SSEEventCredentialAlert;
export type CompleteEvent = SSEEventComplete;
export type ErrorEvent = SSEEventError;
export type ContextUsageEvent = SSEEventContextUsage;
export type ContextManifestEvent = SSEEventContextManifest;
export type CompactEvent = SSEEventCompact;
export type ThinkingEvent = SSEEventThinking;
export type TextStartEvent = SSEEventTextStart;
export type TextDeltaEvent = SSEEventTextDelta;
export type TextEndEvent = SSEEventTextEnd;
export type ToolStartEvent = SSEEventToolStart;
export type ToolResultEvent = SSEEventToolResult;
export type ToolApprovalRequestedEvent = SSEEventToolApprovalRequested;
export type ToolApprovalResolvedEvent = SSEEventToolApprovalResolved;
export type ResultEvent = SSEEventResult;
export type AwaySummaryEvent = SSEEventAwaySummary;
export type TurnSummaryEvent = SSEEventTurnSummary;
export type PromptSuggestionEvent = SSEEventPromptSuggestion;
export type SubagentStartEvent = SSEEventSubagentStart;
export type SubagentStopEvent = SSEEventSubagentStop;
export type ClaudeRuntimeSessionStateEvent = SSEEventClaudeRuntimeSessionState;
export type ClaudeRuntimeTaskStartedEvent = SSEEventClaudeRuntimeTaskStarted;
export type ClaudeRuntimeTaskCreatedEvent = SSEEventClaudeRuntimeTaskCreated;
export type ClaudeRuntimeTaskUpdatedEvent = SSEEventClaudeRuntimeTaskUpdated;
export type ClaudeRuntimeTaskProgressEvent = SSEEventClaudeRuntimeTaskProgress;
export type ClaudeRuntimeTaskCompletedEvent = SSEEventClaudeRuntimeTaskCompleted;
export type ClaudeRuntimeTaskNotificationEvent = SSEEventClaudeRuntimeTaskNotification;
export type ClaudeRuntimeNotificationEvent = SSEEventClaudeRuntimeNotification;
export type ClaudeRuntimeRemoteTriggerEvent = SSEEventClaudeRuntimeRemoteTrigger;
export type ClaudeRuntimeTranscriptMirrorErrorEvent = SSEEventClaudeRuntimeTranscriptMirrorError;
export type ClaudeRuntimeModeStateEvent = SSEEventClaudeRuntimeModeState;
export type ClaudeRuntimeScheduleUpdatedEvent = SSEEventClaudeRuntimeScheduleUpdated;
export type ClaudeRuntimeScheduleDeletedEvent = SSEEventClaudeRuntimeScheduleDeleted;
export type FolderUpdatedEvent = SSEEventFolderUpdated;
export type CustomViewUpdatedEvent = SSEEventCustomViewUpdated;
export type HistorySyncEvent = SSEEventHistorySync;
export type InputRequestEvent = SSEEventInputRequest;
export type InputRequestExpiredEvent = SSEEventInputRequestExpired;
export type InputRequestRespondedEvent = SSEEventInputRequestResponded;
export type AssistantMessageEvent = SSEEventAssistantMessage;

export type GenerationStartedEvent = SSEEventGenerationStarted;
export type SessionEndedEvent = SSEEventSessionEnded;
export type ReportTimelineEvent = SSEEventReportTimeline;
export type ReportTimelineQuestionClosedEvent = SSEEventReportTimelineQuestionClosed;
export type TextSnapshotEvent = SSEEventTextSnapshot;

export type SystemMessageEvent = SSEEventSystemMessage;

export const RETRYING_ERROR_HISTORY =
  "응답 연결이 끊겨 같은 작업에 자동 재연결이 발생했습니다.";

export function formatRetryingErrorHistory(message: string): string {
  return message
    ? `${RETRYING_ERROR_HISTORY} ${message}`
    : RETRYING_ERROR_HISTORY;
}

export interface InputRequestQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export type ClaudeRuntimeHookEvent = SSEEventClaudeRuntimeHookEvent;

export type SoulSSEEvent =
  | ProgressEvent
  | SessionEvent
  | InterventionSentEvent
  | SessionNotificationEvent
  | UserMessageEvent
  | SystemMessageEvent
  | DebugEvent
  | GenerationStartedEvent
  | ReportTimelineEvent
  | ReportTimelineQuestionClosedEvent
  | SSEEventInputMaterialManifest
  | SSEEventUsageObservation
  | SessionEndedEvent
  | CompleteEvent
  | ErrorEvent
  | ContextUsageEvent
  | ContextManifestEvent
  | CompactEvent
  | AssistantErrorEvent
  | CredentialAlertEvent
  | ThinkingEvent
  | TextStartEvent
  | TextDeltaEvent
  | TextEndEvent
  | ToolStartEvent
  | ToolResultEvent
  | ToolApprovalRequestedEvent
  | ToolApprovalResolvedEvent
  | ResultEvent
  | SubagentStartEvent
  | SubagentStopEvent
  | ClaudeRuntimeSessionStateEvent
  | ClaudeRuntimeTaskStartedEvent
  | ClaudeRuntimeTaskCreatedEvent
  | ClaudeRuntimeTaskUpdatedEvent
  | ClaudeRuntimeTaskProgressEvent
  | ClaudeRuntimeTaskCompletedEvent
  | ClaudeRuntimeTaskNotificationEvent
  | ClaudeRuntimeNotificationEvent
  | ClaudeRuntimeRemoteTriggerEvent
  | ClaudeRuntimeTranscriptMirrorErrorEvent
  | ClaudeRuntimeHookEvent
  | ClaudeRuntimeModeStateEvent
  | ClaudeRuntimeScheduleUpdatedEvent
  | ClaudeRuntimeScheduleDeletedEvent
  | FolderUpdatedEvent
  | CustomViewUpdatedEvent
  | InputRequestEvent
  | InputRequestExpiredEvent
  | InputRequestRespondedEvent
  | HistorySyncEvent
  | TextSnapshotEvent
  | AssistantMessageEvent
  | AwaySummaryEvent
  | TurnSummaryEvent
  | PromptSuggestionEvent;
