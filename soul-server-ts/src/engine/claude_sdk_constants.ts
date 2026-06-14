export const SOULSTREAM_SCHEDULE_TOOLS = new Set([
  "ScheduleWakeup",
  "CronCreate",
  "CronList",
  "CronDelete",
]);

export const GENERIC_HOOK_EVENTS = [
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "SessionEnd",
  "StopFailure",
  "PostCompact",
  "PermissionRequest",
  "PermissionDenied",
  "Setup",
  "TeammateIdle",
  "Elicitation",
  "ElicitationResult",
  "ConfigChange",
  "WorktreeCreate",
  "WorktreeRemove",
  "InstructionsLoaded",
  "CwdChanged",
  "FileChanged",
] as const;

export type GenericHookEventName = (typeof GENERIC_HOOK_EVENTS)[number];
