import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { useDashboardStore } from "@seosoyoung/soul-ui";
import { PersistentSessionTaskList } from "./PersistentSessionTaskList";
import { reviewCard, reviewSession, reviewTitle } from "./components-review-fixtures";
import { useEffect } from "react";
import "./v3-persistent-task-list.css";

const taskAssignee = { ...reviewSession, agentSessionId: "persistent-task-review-session", agentPortraitUrl: undefined };

const taskFixture: CardRow[] = ([
  ["running", 7], ["blocked", 98], ["review", 412], ["queued", 1024], ["todo", 55],
  ["done", 76], ["cancelled", 77],
] as const).map(([status, number], index) => ({
  ...reviewCard,
  id: `persistent-task-${status}`,
  assigneeSessionId: taskAssignee.agentSessionId,
  number,
  status,
  title: number === 1024 ? reviewTitle : `카드 ${number}`,
  positionKey: String.fromCharCode(97 + index),
  queuePositionKey: String.fromCharCode(97 + index),
}));

const listWidths = [240, 264] as const;

export function PersistentSessionTaskListReviewSample() {
  const catalog = useDashboardStore(state => state.catalog);
  const setCatalog = useDashboardStore(state => state.setCatalog);
  useEffect(() => {
    if (catalog?.sessionList?.some(session => session.agentSessionId === taskAssignee.agentSessionId && session.agentName)) return;
    const current = useDashboardStore.getState().catalog;
    if (current?.sessionList?.some(session => session.agentSessionId === taskAssignee.agentSessionId && session.agentName)) return;
    setCatalog({
      ...(current ?? { folders: [], sessions: {} }),
      sessionList: [...(current?.sessionList ?? []).filter(session => session.agentSessionId !== taskAssignee.agentSessionId), taskAssignee],
    });
  }, [catalog, setCatalog]);

  useEffect(() => () => {
      const latest = useDashboardStore.getState().catalog;
      if (!latest) return;
      const sessionList = (latest.sessionList ?? []).filter(session => session.agentSessionId !== taskAssignee.agentSessionId);
      if (sessionList.length !== latest.sessionList?.length) {
        useDashboardStore.getState().setCatalog({ ...latest, sessionList });
      }
  }, []);

  return <div className="v3-persistent-task-review" data-testid="persistent-task-review-sample">
    <div className="v3-persistent-task-review-lists">
      {listWidths.map(width=><div key={width} className="v3-persistent-task-review-list" style={{width}} data-list-width={width}>
        <PersistentSessionTaskList cards={taskFixture} onOpenCard={() => {}}/>
      </div>)}
    </div>
  </div>;
}
