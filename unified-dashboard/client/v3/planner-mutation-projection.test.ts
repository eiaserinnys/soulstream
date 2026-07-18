import { describe, expect, it } from "vitest";
import type { PageDto } from "@seosoyoung/soul-ui/page";

import type { PlannerTask } from "./planner-data";
import {
  movePlannerTaskProject,
  movePlannerSession,
  projectPagesForTasks,
  removePlannerSessions,
  replacePlannerTask,
} from "./planner-mutation-projection";

describe("planner mutation projection", () => {
  it("replaces only the changed task and retains every untouched identity", () => {
    const first = task("first", ["session-1"]);
    const second = task("second", ["session-2"]);
    const tasks = [first, second];

    const next = replacePlannerTask(tasks, "first", (current) => ({
      ...current,
      page: { ...current.page, title: "바뀐 업무" },
    }));

    expect(next).not.toBe(tasks);
    expect(next[0]).not.toBe(first);
    expect(next[0]?.page.title).toBe("바뀐 업무");
    expect(next[1]).toBe(second);
    expect(replacePlannerTask(next, "missing", (current) => current)).toBe(next);
  });

  it("retains the original array for equivalent replacements and no-op removals", () => {
    const first = task("first", ["session-1"]);
    const tasks = [first];

    expect(replacePlannerTask(tasks, "first", (current) => ({
      ...current,
      page: { ...current.page },
      sessionIds: [...current.sessionIds],
    }))).toBe(tasks);
    expect(removePlannerSessions(tasks, new Set())).toBe(tasks);
    expect(removePlannerSessions(tasks, new Set(["missing-session"]))).toBe(tasks);
  });

  it("removes deleted sessions without recreating unrelated tasks", () => {
    const first = task("first", ["session-1", "session-2"]);
    const second = task("second", ["session-3"]);

    const next = removePlannerSessions([first, second], new Set(["session-2"]));

    expect(next[0]?.sessionIds).toEqual(["session-1"]);
    expect(next[1]).toBe(second);
  });

  it("moves one session between loaded tasks and preserves all other rows", () => {
    const source = task("source", ["session-1", "session-2"]);
    const target = task("target", ["session-3"]);
    const untouched = task("untouched", ["session-4"]);

    const next = movePlannerSession(
      [source, target, untouched],
      "session-2",
      "target",
    );

    expect(next[0]?.sessionIds).toEqual(["session-1"]);
    expect(next[1]?.sessionIds).toEqual(["session-3", "session-2"]);
    expect(next[2]).toBe(untouched);
  });

  it("covers loaded source and target visibility without inventing a hidden source", () => {
    const targetOnly = task("target", ["session-target"]);
    expect(movePlannerSession([targetOnly], "session-external", "target")[0]?.sessionIds)
      .toEqual(["session-target", "session-external"]);

    const sourceOnly = task("source", ["session-moving"]);
    expect(movePlannerSession([sourceOnly], "session-moving", "hidden-target")[0]?.sessionIds)
      .toEqual([]);

    const unrelated = task("unrelated", ["session-other"]);
    const unrelatedTasks = [unrelated];
    expect(movePlannerSession(unrelatedTasks, "session-moving", "hidden-target"))
      .toBe(unrelatedTasks);

    const alreadyInTarget = task("target", ["session-moving"]);
    const targetTasks = [alreadyInTarget];
    expect(movePlannerSession(targetTasks, "session-moving", "target"))
      .toBe(targetTasks);
  });

  it("projects a project move into the visible source or target without broad replacement", () => {
    const moving = { ...task("moving", []), projectPageId: "project-source" };
    const untouched = { ...task("untouched", []), projectPageId: "project-source" };

    const source = movePlannerTaskProject(
      [moving, untouched],
      moving,
      "project-target",
      "project-source",
    );
    expect(source).toEqual([untouched]);
    expect(source[0]).toBe(untouched);

    const target = movePlannerTaskProject(
      [untouched],
      moving,
      "project-target",
      "project-target",
    );
    expect(target).toEqual([untouched, { ...moving, projectPageId: "project-target" }]);
    expect(target[0]).toBe(untouched);
  });

  it("keeps daily project labels aligned with the projected task memberships", () => {
    const source = page("project-source");
    const target = page("project-target");
    const moving = { ...task("moving", []), projectPageId: "project-target" };

    expect(projectPagesForTasks([source], [moving], target)).toEqual([target]);
  });
});

function task(id: string, sessionIds: string[]): PlannerTask {
  return {
    page: page(id),
    blocks: [],
    stateVector: "state-vector",
    taskId: `task-${id}`,
    task: null,
    status: "open",
    assignee: "",
    contextCount: 0,
    progress: null,
    projectPageId: null,
    sessionIds,
    mountedDocuments: [],
  };
}

function page(id: string): PageDto {
  return {
    id,
    title: id,
    icon: null,
    coverUrl: null,
    parentId: null,
    position: "a0",
    createdBy: null,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    metadata: {},
  } as unknown as PageDto;
}
