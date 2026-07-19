// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@seosoyoung/soul-ui";

vi.mock("@seosoyoung/soul-ui", () => ({
  DashboardIconCap: ({
    children,
    label,
    className,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) => (
    <button
      {...props}
      className={`dashboard-icon-cap ${className ?? ""}`}
      data-slot="dashboard-icon-cap"
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  ),
}));

vi.mock("@seosoyoung/soul-ui/components/LiquidGlassCard", () => ({
  LiquidGlassCard: ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => (
    <article {...props}>{children}</article>
  ),
}));

vi.mock("./V3ContextMenu", () => ({ V3ContextMenu: () => null }));
vi.mock("./use-task-star", () => ({
  useTaskStar: () => ({ starred: false, pending: false, toggle: async () => undefined }),
}));

import { PlannerTaskCard } from "./PlannerTaskCard";

describe("PlannerTaskCard node connectivity", () => {
  it("hides internal and empty metadata while keeping meaningful assignees", () => {
    const html = renderToStaticMarkup(
      <PlannerTaskCard
        task={{
          page: { id: "page-a", title: "정보를 덜어낸 업무" },
          taskId: "aae680d9-internal-task-id",
          sessionIds: ["session-a"],
          status: "in_progress",
          assignee: "담당 미지정",
          contextCount: 3,
          progress: 0,
          projectPageId: null,
        } as never}
        sessions={[{
          agentSessionId: "session-a",
          status: "completed",
          nodeId: "node-online",
          eventCount: 0,
          createdAt: "2026-07-16T00:00:00Z",
        } as SessionSummary]}
        nodeConnectivity={{ ready: true, connectedNodeIds: new Set(["node-online"]) }}
        isInToday
        onOpen={() => undefined}
        onComplete={async () => undefined}
        onToggleToday={async () => undefined}
        onMoveToProject={() => undefined}
      />,
    );

    expect(html).not.toContain("aae680d9");
    expect(html).not.toContain("담당 미지정");
    expect(html).not.toContain("컨텍스트 3");
    expect(html).not.toContain("세션 #1 완료");
    expect(html).toContain('data-complete="false"');
  });

  it("keeps a meaningful assignee and an actively running session", () => {
    const html = renderToStaticMarkup(
      <PlannerTaskCard
        task={{
          page: { id: "page-b", title: "진행 중인 업무" },
          taskId: "rb-running",
          sessionIds: ["session-b"],
          status: "in_progress",
          assignee: "로젤린",
          contextCount: 1,
          progress: 20,
          projectPageId: null,
        } as never}
        sessions={[{
          agentSessionId: "session-b",
          status: "running",
          nodeId: "node-online",
          eventCount: 0,
          createdAt: "2026-07-16T00:00:00Z",
        } as SessionSummary]}
        nodeConnectivity={{ ready: true, connectedNodeIds: new Set(["node-online"]) }}
        isInToday
        onOpen={() => undefined}
        onComplete={async () => undefined}
        onToggleToday={async () => undefined}
        onMoveToProject={() => undefined}
      />,
    );

    expect(html).toContain("로젤린");
    expect(html).toContain("세션 #1 실행 중");
    expect(html).not.toContain("컨텍스트 1");
  });

  it("does not present the latest run as active when its node is offline", () => {
    const html = renderToStaticMarkup(
      <PlannerTaskCard
        task={{
          page: { id: "page-a", title: "노드 상태 업무" },
          taskId: "rb-node-offline",
          sessionIds: ["session-a"],
          status: "in_progress",
          assignee: "로젤린",
          contextCount: 0,
          progress: 50,
          projectPageId: null,
        } as never}
        sessions={[{
          agentSessionId: "session-a",
          status: "running",
          nodeId: "node-offline",
          eventCount: 0,
          createdAt: "2026-07-16T00:00:00Z",
        } as SessionSummary]}
        nodeConnectivity={{ ready: true, connectedNodeIds: new Set(["node-online"]) }}
        isInToday
        onOpen={() => undefined}
        onComplete={async () => undefined}
        onToggleToday={async () => undefined}
        onMoveToProject={() => undefined}
      />,
    );

    expect(html).toContain("세션 #1 노드 오프라인");
    expect(html).not.toContain('aria-label="실행 중"');
  });

  it("keeps body, state, and star in fixed columns and marks only 100 percent complete", () => {
    const html = renderToStaticMarkup(
      <PlannerTaskCard
        task={{
          page: { id: "page-complete", title: "완료된 업무" },
          taskId: "rb-complete",
          sessionIds: [],
          status: "completed",
          assignee: "로젤린",
          contextCount: 0,
          progress: 100,
          projectPageId: null,
        } as never}
        sessions={[]}
        nodeConnectivity={{ ready: true, connectedNodeIds: new Set() }}
        isInToday
        onOpen={() => undefined}
        onComplete={async () => undefined}
        onToggleToday={async () => undefined}
        onMoveToProject={() => undefined}
      />,
    );

    expect(html).toContain('class="v3-task-main"');
    expect(html).toContain('class="v3-task-state"');
    expect(html).toContain('class="v3-task-star-slot"');
    expect(html).toContain('data-complete="true"');
  });
});
