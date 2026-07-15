/**
 * @vitest-environment jsdom
 */

import { useEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { CatalogFolder } from "@seosoyoung/soul-ui";
import type { PageApiClient, PageDto } from "@seosoyoung/soul-ui/page";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectFolderResolutionView } from "./ProjectFolderResolutionView";
import { useProjectFolderController } from "./use-project-folder-controller";

describe("project folder resolution", () => {
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

  it("renders loading while resolution is delayed, then opens the project", async () => {
    const pending = deferred<{ page: PageDto; blocks: []; state_vector: string }>();
    const api = { getPage: vi.fn(() => pending.promise) } as unknown as PageApiClient;
    const project = page("project-a", "프로젝트 A");

    renderHarness({ api, folder: folder(project.id, project.title), notify: vi.fn() });
    await waitFor(() => expect(container.textContent).toContain("불러오는 중…"));
    expect(container.querySelector('[data-testid="v3-empty-project-view"]')).toBeNull();

    pending.resolve({ page: project, blocks: [], state_vector: "AA==" });
    await waitFor(() => expect(container.textContent).toContain("프로젝트 A 열림"));
  });

  it("renders a retryable error and notifies, then recovers", async () => {
    const project = page("project-error", "오류 프로젝트");
    const api = {
      getPage: vi.fn()
        .mockRejectedValueOnce(new Error("fixture resolve failure"))
        .mockResolvedValueOnce({ page: project, blocks: [], state_vector: "AA==" }),
    } as unknown as PageApiClient;
    const notify = vi.fn();

    renderHarness({ api, folder: folder(project.id, project.title), notify });
    await waitFor(() => expect(container.textContent).toContain("프로젝트를 열지 못했습니다."));
    expect(container.textContent).toContain("다시 시도");
    expect(container.textContent).not.toContain("프로젝트 페이지가 비어 있거나 아직 연결되지 않았습니다.");
    expect(notify).toHaveBeenCalledWith("프로젝트를 열지 못했습니다.");

    container.querySelector<HTMLButtonElement>("button")?.click();
    await waitFor(() => expect(container.textContent).toContain("오류 프로젝트 열림"));
    expect(api.getPage).toHaveBeenCalledTimes(2);
  });

  it("renders the quiet empty state only after an unlinked folder resolves", async () => {
    const api = { getPage: vi.fn() } as unknown as PageApiClient;
    renderHarness({ api, folder: folder(null, "레거시 폴더"), notify: vi.fn() });

    await waitFor(() => expect(container.querySelector('[data-testid="v3-empty-project-view"]')).not.toBeNull());
    expect(container.textContent).toContain("내용이 없습니다.");
    expect(container.textContent).not.toContain("아직 연결되지 않았습니다");
    expect(api.getPage).not.toHaveBeenCalled();
  });

  it("does not let an older delayed resolution overwrite the latest folder", async () => {
    const firstPending = deferred<{ page: PageDto; blocks: []; state_vector: string }>();
    const first = page("project-first", "첫 프로젝트");
    const second = page("project-second", "둘째 프로젝트");
    const api = {
      getPage: vi.fn((pageId: string) => pageId === first.id
        ? firstPending.promise
        : Promise.resolve({ page: second, blocks: [], state_vector: "AA==" })),
    } as unknown as PageApiClient;
    const notify = vi.fn();

    renderHarness({ api, folder: folder(first.id, first.title), notify });
    await waitFor(() => expect(container.textContent).toContain("불러오는 중…"));
    renderHarness({ api, folder: folder(second.id, second.title), notify });
    await waitFor(() => expect(container.textContent).toContain("둘째 프로젝트 열림"));

    firstPending.resolve({ page: first, blocks: [], state_vector: "AA==" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toContain("둘째 프로젝트 열림");
    expect(container.textContent).not.toContain("첫 프로젝트 열림");
  });

  function renderHarness(props: HarnessProps) {
    flushSync(() => root.render(<Harness {...props} />));
  }
});

interface HarnessProps {
  api: PageApiClient;
  folder: CatalogFolder;
  notify(message: string): void;
}

function Harness({ api, folder, notify }: HarnessProps) {
  const controller = useProjectFolderController();
  useEffect(() => {
    void controller.openFolder(api, folder, [], notify);
  }, [api, controller.openFolder, folder, notify]);

  if (controller.resolution.status === "ready" && controller.selectedProject) {
    return <div>{controller.selectedProject.title} 열림</div>;
  }
  return (
    <ProjectFolderResolutionView
      state={controller.resolution}
      title={folder.name}
      onRetry={() => { void controller.retry(); }}
    />
  );
}

async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let index = 0; index < 40; index += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function folder(projectPageId: string | null, name: string): CatalogFolder {
  return {
    id: `folder-${name}`,
    name,
    sortOrder: 0,
    parentFolderId: null,
    projectPageId,
  };
}

function page(id: string, title: string): PageDto {
  return {
    id,
    title,
    daily_date: null,
    version: 1,
    archived: false,
    metadata: {},
    created_at: "2026-07-16T00:00:00Z",
    updated_at: "2026-07-16T00:00:00Z",
  };
}
