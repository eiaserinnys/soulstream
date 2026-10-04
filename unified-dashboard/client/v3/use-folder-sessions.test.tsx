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

  it("allows only one request before React renders the loading state", async () => {
    let resolve!: (page: PlannerPage<SessionSummary>) => void;
    const fetchPlanner = vi.fn(() => new Promise<PlannerPage<SessionSummary>>(done => { resolve = done; }));
    const initial = { items: [session("first")], nextCursor: "older" };
    flushSync(() => root.render(<Harness dependencies={{ fetchPlanner }} folderId="folder-a" initial={initial} />));
    container.querySelector<HTMLButtonElement>("button")!.click();
    container.querySelector<HTMLButtonElement>("button")!.click();
    expect(fetchPlanner).toHaveBeenCalledOnce();
    resolve({ items: [session("second")], nextCursor: null });
    await vi.waitFor(() => expect(container.textContent).toContain("first,second"));
  });

  it("exposes a failure until the next explicit load starts", async () => {
    const fetchPlanner = vi.fn().mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ items: [session("second")], nextCursor: null });
    const initial = { items: [session("first")], nextCursor: "older" };
    flushSync(() => root.render(<Harness dependencies={{ fetchPlanner }} folderId="folder-a" initial={initial} />));
    container.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(container.querySelector('[data-testid="sessions"]')?.getAttribute("data-failed")).toBe("true"));
    container.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(container.querySelector('[data-testid="sessions"]')?.getAttribute("data-failed")).toBe("false"));
    expect(container.textContent).toContain("first,second");
  });

  it("starts B while A is pending and ignores the late A response", async () => {
    let resolveA!: (page: PlannerPage<SessionSummary>) => void;
    const fetchPlanner = vi.fn().mockImplementationOnce(() => new Promise(done => { resolveA = done; }))
      .mockResolvedValueOnce({ items: [session("b-second")], nextCursor: null });
    const dependencies = { fetchPlanner };
    flushSync(() => root.render(<Harness dependencies={dependencies} folderId="folder-a"
      initial={{ items: [session("a-first")], nextCursor: "a-older" }} />));
    container.querySelector<HTMLButtonElement>("button")!.click();
    flushSync(() => root.render(<Harness dependencies={dependencies} folderId="folder-b"
      initial={{ items: [session("b-first")], nextCursor: "b-older" }} />));
    await vi.waitFor(() => expect(container.textContent).toContain("b-first"));
    container.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(container.textContent).toContain("b-first,b-second"));
    resolveA({ items: [session("a-second")], nextCursor: null });
    await Promise.resolve();
    expect(container.textContent).not.toContain("a-second");
  });
  it("keeps loaded pages and cursor when an updated first slice arrives", async () => {
    const fetchPlanner = vi.fn(async () => ({ items: [session("second")], nextCursor: "oldest" }));
    const dependencies = { fetchPlanner };
    flushSync(() => root.render(<Harness dependencies={dependencies} folderId="folder-a"
      initial={{ items: [session("first")], nextCursor: "older" }} />));
    container.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(container.textContent).toContain("first,second"));
    flushSync(() => root.render(<Harness dependencies={dependencies} folderId="folder-a"
      initial={{ items: [{ ...session("first"), status: "running" }], nextCursor: "older" }} />));
    await vi.waitFor(() => expect(container.textContent).toContain("first,second"));
    container.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(fetchPlanner).toHaveBeenLastCalledWith("/api/planner/folders/folder-a/sessions?cursor=oldest"));
  });

});

function Harness({ dependencies, folderId, initial }: {
  dependencies: PlannerDataDependencies;
  folderId: string;
  initial: PlannerPage<SessionSummary>;
}) {
  const controller = useFolderSessions({ dependencies, folderId, initial, notify: vi.fn() });
  return <div>
    <span data-testid="sessions" data-failed={controller.state?.loadFailed}>{controller.state?.items.map((item) => item.agentSessionId).join(",")}</span>
    <button type="button" onClick={() => { void controller.loadMore(); }}>더 보기</button>
  </div>;
}
