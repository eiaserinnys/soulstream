import type { SessionStatus } from "../../shared/types";
import { STATUS_CONFIG, type StatusConfig } from "../SessionItem";

export const CHAT_STATUS_TONE_CONFIG: Record<SessionStatus, StatusConfig> = {
  running: {
    ...STATUS_CONFIG.running,
    dotClass: "chat-tone-success-dot",
    chipClass: "chat-tone-success",
  },
  completed: STATUS_CONFIG.completed,
  error: {
    ...STATUS_CONFIG.error,
    dotClass: "chat-tone-danger-dot",
    chipClass: "chat-tone-danger",
  },
  interrupted: {
    ...STATUS_CONFIG.interrupted,
    dotClass: "chat-tone-warning-dot",
    chipClass: "chat-tone-warning",
  },
  unknown: {
    ...STATUS_CONFIG.unknown,
    dotClass: "bg-muted-foreground",
    chipClass: "chat-tone-warning",
  },
};
