export type TaskStatus =
  | "open"
  | "in_progress"
  | "agent_done"
  | "verified_done"
  | "reopened"
  | "blocked"
  | "cancelled";

export type VerificationOwner = "agent" | "user" | "both";

export interface TaskItem {
  id: string;
  parentId: string | null;
  positionKey: number;
  title: string;
  description: string;
  acceptanceCriteria: string;
  verificationOwner: VerificationOwner;
  status: TaskStatus;
  linkedSessionId: string | null;
  linkedNodeId: string | null;
  activeForSessionId: string | null;
  createdFromSessionId: string | null;
  createdFromEventId: number | null;
  navigationSessionId: string | null;
  navigationNodeId: string | null;
  navigationEventId: number | null;
  archived: boolean;
  pinned: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskListResponse {
  tasks: TaskItem[];
}
