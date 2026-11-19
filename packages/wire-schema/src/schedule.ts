export type SoulstreamScheduleKind = "wakeup" | "cron";

export type SoulstreamScheduleStatus =
  | "active"
  | "dispatching"
  | "firing"
  | "completed"
  | "cancelled"
  | "failed"
  | "orphaned";

export interface SoulstreamSchedule {
  scheduleId: string;
  sessionId: string;
  kind: SoulstreamScheduleKind;
  status: SoulstreamScheduleStatus;
  prompt: string;
  sourceTool: string;
  toolUseId: string | null;
  cronExpression: string | null;
  runOnceAt: string | null;
  timezone: string;
  recurring: boolean;
  nextRunAt: string | null;
  lastFiredAt: string | null;
  firedCount: number;
  dispatchFailureCount: number;
  lastError: string | null;
  claimToken: string | null;
  claimedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleCreateInput {
  scheduleId: string;
  sessionId: string;
  kind: SoulstreamScheduleKind;
  prompt: string;
  sourceTool: string;
  toolUseId?: string | null;
  cronExpression?: string | null;
  runOnceAt?: Date | null;
  timezone?: string;
  recurring: boolean;
  nextRunAt: Date;
  createdAt?: Date;
}

export interface ClaimedSchedule {
  schedule: SoulstreamSchedule;
  claimToken: string;
}

export type ResumeDispatchDecision =
  | { decision: "fire"; reason: null }
  | { decision: "defer"; reason: string }
  | { decision: "close"; reason: string };

export type CancelScheduleOutcome =
  | "cancelled"
  | "already_firing"
  | "not_cancellable"
  | "not_found";

export interface CancelScheduleResult {
  outcome: CancelScheduleOutcome;
  schedule: SoulstreamSchedule | null;
}
