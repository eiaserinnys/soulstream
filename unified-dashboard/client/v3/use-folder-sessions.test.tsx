/** @vitest-environment jsdom */
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@seosoyoung/soul-ui";
import type { PlannerDataDependencies, PlannerPage } from "./planner-data";
import { useFolderSessions } from "./use-folder-sessions";

const session = (id: string) => ({ agentSessionId: id, status: "completed", eventCount: 0 }) as SessionSummary;

describe("useFolderSessions", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  it("uses the aggregate first slice and appends only the next cursor page", async () => {
    const fetchPlanner = vi.fn(async () => ({
      items: [session("first"), session("second")], nextCursor: null,
    }));
    const dependencies = { fetchPlanner } satisfies PlannerDataDependencies;
    const initial = { items: [session("first")], nextCursor: "older" };
    flushSync(() => root.render(<Harness dependencies={dependencies} folderId="folder-a" initial={initial} />));
    expect(container.querySelector("[data-testid=sessions]")?.textContent).toBe("first");
    expect(fetchPlanner).not.toHaveBeenCalled();

    container.querySelector<HTMLButtonElement>("button")?.click();
    await vi.waitFor(() => expect(container.querySelector("[data-testid=sessions]")?.textContent)
      .toBe("first,second"));
    expect(fetchPlanner).toHaveBeenCalledOnce();
    expect(fetchPlanner).toHaveBeenCalledWith("/api/planner/folders/folder-a/sessions?cursor=older");
  });
});

function Harness({ dependencies, folderId, initial }: {
  dependencies: PlannerDataDependencies;
  folderId: string;
  initial: PlannerPage<SessionSummary>;
}) {
  const controller = useFolderSessions({ dependencies, folderId, initial, notify: vi.fn() });
  return <div>
    <span data-testid="sessions">{controller.state?.items.map((item) => item.agentSessionId).join(",")}</span>
    <button type="button" onClick={() => { void controller.loadMore(); }}>더 보기</button>
  </div>;
}
