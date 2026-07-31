import {
  createPageApiClient,
} from "@seosoyoung/soul-ui/page";
import type { SessionSummary } from "@seosoyoung/soul-ui";

import { SearchModal } from "../components/SearchModal";
import {
  loadPlannerTaskByTaskId,
  type PlannerTask,
} from "./planner-data";
import { errorText } from "./v3-dashboard-utils";

type V3SearchModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: SessionSummary[];
  onOpenSession: (
    sessionId: string,
    focusEventId: number | null,
    session?: SessionSummary,
  ) => boolean | void | Promise<boolean | void>;
  api: ReturnType<typeof createPageApiClient>;
  onOpenProjectPage: (pageId: string) => void;
  onOpenTask: (task: PlannerTask) => void;
  notify: (message: string) => void;
};

export function V3SearchModal({
  open,
  onOpenChange,
  sessions,
  onOpenSession,
  api,
  onOpenProjectPage,
  onOpenTask,
  notify,
}: V3SearchModalProps) {
  return (
    <SearchModal
      open={open}
      onOpenChange={onOpenChange}
      sessions={sessions}
      onOpenSession={onOpenSession}
      onOpenFolder={(result) => onOpenProjectPage(result.project_page_id)}
      onOpenTask={async (result) => {
        try {
          onOpenTask(await loadPlannerTaskByTaskId(api, result.id));
        } catch (error) {
          notify(`검색 업무 열기 실패 · ${errorText(error)}`);
        }
      }}
    />
  );
}
