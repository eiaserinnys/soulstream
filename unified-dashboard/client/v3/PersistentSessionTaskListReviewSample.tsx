import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { useDashboardStore } from "@seosoyoung/soul-ui";
import { PersistentSessionTaskList } from "./PersistentSessionTaskList";
import { PersistentTaskTooltipPanel } from "./PersistentTaskTooltipPanel";
import { reviewCard, reviewSession, reviewTitle } from "./components-review-fixtures";
import { useEffect, type CSSProperties } from "react";
import "./v3-persistent-task-list.css";
import "./persistent-report.css";

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
const tooltipReviewSamples = [
  { state: "truncated-title-now", content: { title: "PAS 카드 목록 호버 툴팁 시안 제목 전문", now: "세라피엘 설계안을 받아 시안 장면을 정리했습니다" }, options: [], sending: false, error: false },
  { state: "now-ask-options", content: { now: "세라피엘 설계안을 받아 시안 장면을 정리했습니다", ask: "이 장면들로 시안을 만들까요?" }, options: ["계속", "수정 요청"], sending: false, error: false },
  { state: "long-content", content: { now: "Claude 러너가 정상 종료할 때 자식 프로세스가 함께 끝나 결과 회수가 끊기는 경로는 재현했습니다. 비정상 종료 경로는 아직 재현하지 못해 노드 세 곳의 로그 수집 범위를 넓히고, 재시작 직후 들어온 알림이 사라지는 사례를 함께 모으며 다시 시도하는 중입니다" }, options: [], sending: false, error: false },
  { state: "send-failed", content: { now: "선택을 기다립니다", ask: "계속할까요?" }, options: ["계속", "보류"], sending: false, error: true },
] as const;

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
    <div className="v3-persistent-task-review-lists" data-testid="persistent-task-tooltip-review-samples">
      {tooltipReviewSamples.map(sample => <div key={sample.state} className="v3-persistent-task-review-list" style={{width:listWidths[1]}} data-tooltip-review-state={sample.state}>
        <div className="v3-persistent-task-tooltip" style={{width:"100%", "--anchor-width":"100%"} as CSSProperties}>
          <div className="v3-surface"><PersistentTaskTooltipPanel content={sample.content} options={sample.options} sending={sample.sending} error={sample.error} onSelect={() => {}}/></div>
        </div>
      </div>)}
    </div>
  </div>;
}
