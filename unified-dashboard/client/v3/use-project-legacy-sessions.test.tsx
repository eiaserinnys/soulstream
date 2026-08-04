/**
 * @vitest-environment jsdom
 */

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlannerDataDependencies } from "./planner-data";
import { useProjectLegacySessions } from "./use-project-legacy-sessions";

describe("useProjectLegacySessions", () => {
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

  it("stays hidden without a project-folder mapping and loads only after one exists", async () => {
    const fetchPlanner = vi.fn(async () => ({
      items: [{ agentSessionId: "legacy-a", status: "completed", eventCount: 0 }],
      next_cursor: null,
    }));
    const dependencies = { fetchPlanner } satisfies PlannerDataDependencies;
    const notify = vi.fn();

    render({ dependencies, projectPageId: "project-a", folderMapped: false, notify });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stateText()).toBe("hidden");
    expect(fetchPlanner).not.toHaveBeenCalled();

    render({ dependencies, projectPageId: "project-a", folderMapped: true, notify });
    await vi.waitFor(() => expect(stateText()).toBe("ready:1"));
    expect(fetchPlanner).toHaveBeenCalledOnce();
    expect(fetchPlanner).toHaveBeenCalledWith(
      "/api/planner/projects/project-a/legacy-sessions",
    );
  });

  it("appends cursor pages without duplicating a session", async () => {
    const fetchPlanner = vi.fn()
      .mockResolvedValueOnce({
        items: [{ agentSessionId: "legacy-a", status: "completed", eventCount: 0 }],
        next_cursor: "older",
      })
      .mockResolvedValueOnce({
        items: [
          { agentSessionId: "legacy-a", status: "completed", eventCount: 0 },
          { agentSessionId: "legacy-b", status: "completed", eventCount: 0 },
        ],
        next_cursor: null,
      });
    const dependencies = { fetchPlanner } satisfies PlannerDataDependencies;

    render({ dependencies, projectPageId: "project-a", folderMapped: true, notify: vi.fn() });
    await vi.waitFor(() => expect(stateText()).toBe("ready:1"));
    container.querySelector<HTMLButtonElement>("button")?.click();
    await vi.waitFor(() => expect(stateText()).toBe("ready:2"));

    expect(fetchPlanner).toHaveBeenNthCalledWith(
      2,
      "/api/planner/projects/project-a/legacy-sessions?cursor=older",
    );
  });

  function render(props: HarnessProps) {
    flushSync(() => root.render(<Harness {...props} />));
  }

  function stateText(): string | null {
    return container.querySelector('[data-testid="legacy-state"]')?.textContent ?? null;
  }
});

interface HarnessProps {
  dependencies: PlannerDataDependencies;
  projectPageId: string | null;
  folderMapped: boolean;
  notify(message: string): void;
}

function Harness(props: HarnessProps) {
  const controller = useProjectLegacySessions(props);
  return (
    <div>
      <span data-testid="legacy-state">{controller.state
        ? `${controller.state.status}:${controller.state.items.length}`
        : "hidden"}</span>
      {controller.state?.nextCursor ? (
        <button type="button" onClick={() => { void controller.loadMore(); }}>더 보기</button>
      ) : null}
    </div>
  );
}
