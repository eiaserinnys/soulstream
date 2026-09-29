import type { SessionSummary } from "@seosoyoung/soul-ui";
import type { ChatFocusTarget } from "@seosoyoung/soul-ui";

import { SearchModal } from "../components/SearchModal";

type V3SearchModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: SessionSummary[];
  onOpenSession: (
    sessionId: string,
    focusEventId: number | null,
    session?: SessionSummary,
    focusTarget?: ChatFocusTarget,
  ) => boolean | void | Promise<boolean | void>;
  onOpenFolder: (folderId: string) => void;
};

export function V3SearchModal({
  open,
  onOpenChange,
  sessions,
  onOpenSession,
  onOpenFolder,
}: V3SearchModalProps) {
  return (
    <SearchModal
      open={open}
      onOpenChange={onOpenChange}
      sessions={sessions}
      onOpenSession={onOpenSession}
      onOpenFolder={(result) => onOpenFolder(result.folder_id)}
    />
  );
}
