export const UI_EVENT_SCHEMA_VERSION = "soulstream.ui_event.v1";

export const UI_EVENT_TYPES = [
  "view_open",
  "search_submit",
  "search_result",
  "search_result_open",
  "notification_open",
  "compose_start",
  "compose_submit",
  "compose_result",
  "compose_abandon",
  "compose_resume",
  "app_active",
  "app_inactive",
  "action_start",
  "action_end",
] as const;
export type UiEventType = (typeof UI_EVENT_TYPES)[number];

export const UI_EVENT_TARGET_KINDS = [
  "session",
  "card",
  "folder",
  "page",
  "document",
  "feed",
  "view",
  "custom_view",
] as const;
export type UiEventTargetKind = (typeof UI_EVENT_TARGET_KINDS)[number];

export const UI_EVENT_ENTRIES = [
  "sidebar",
  "feed",
  "search",
  "notification",
  "my_turn",
  "url",
  "history",
  "auto",
  "nav",
] as const;
export type UiEventEntry = (typeof UI_EVENT_ENTRIES)[number];

export type UiEventAttrValue = string | number | boolean;
