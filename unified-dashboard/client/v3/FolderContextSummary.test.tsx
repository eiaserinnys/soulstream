/**
 * @vitest-environment jsdom
 */

import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogFolder } from "@seosoyoung/soul-ui";

import { dialoguesAssignment } from "./dialogues-api";
import { FolderWorkspaceSections } from "./FolderWorkspaceSections";
import { ProjectDialog, type ProjectDialogTarget } from "./ProjectDialog";
import { fetchProjectPageDetails, type ProjectPageSnapshot } from "./project-page-details";

vi.mock("./project-page-details", async (importOriginal) => {
  const original = await importOriginal<typeof import("./project-page-details")>();
  return { ...original, fetchProjectPageDetails: vi.fn() };
});

const folder: CatalogFolder = { status: "open", version: 1, archived: false, id: "amber", name: "앰버", sortOrder: 0, projectPageId: "amber-page" };
const snapshot: ProjectPageSnapshot = {
  page: { id: "amber-page", title: "앰버", daily_date: null, version: 1, archived: false, metadata: {}, created_at: "", updated_at: "" },
  blocks: [],
  stateVector: "",
  guidance: [{ blockId: "g", text: "결정은 근거와 함께 기록한다.", scope: "project" }],
  atomReferences: [{ blockId: "a", instance: "atom", nodeId: "n", nodeTitle: "프론트엔드 아키텍처", depth: 2, titlesOnly: true, limit: 5, mode: "index" }],
  sessionDefaults: [{ blockId: "d", scope: "session", agentId: "roselin", nodeId: "sample-node", modelPreset: "sample-sol" }],
};

function Harness() {
  const [target, setTarget] = useState<ProjectDialogTarget | null>(null);
  return <>
    <FolderWorkspaceSections folder={folder} parentFolder={null} folders={[folder]} children={[]} hasMoreChildren={false}
      childrenLoadingMore={false} onLoadMoreChildren={vi.fn()} knownPages={[]} sessions={[]} nodeConnectivity={{} as never}
      invalidationKey={0} contextSavedKey={0} onOpenFolder={vi.fn()} onCreateSubfolder={vi.fn()}
      onOpenSettings={() => setTarget({ mode: "edit", folder })}
      onRenameChild={vi.fn()} onArchiveChild={vi.fn()} onCompleteFolder={vi.fn()} onMoveFolderToParent={vi.fn()} onBlocksChanged={vi.fn()} />
    <ProjectDialog target={target} folders={[folder]} assignment={dialoguesAssignment} onClose={() => setTarget(null)}
      onCreateIdentity={vi.fn()} onRename={vi.fn()} onSaveContext={vi.fn()} onSaved={vi.fn()} />
  </>;
}

describe("folder context summary", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.mocked(fetchProjectPageDetails).mockResolvedValue(snapshot);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ agents: [{ id: "roselin", name: "로젤린" }], model_presets: [{ id: "sample-sol", label: "Sol" }] })));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    flushSync(() => root.unmount());
    document.body.replaceChildren();
  });

  it("reads the folder's instructions, reference titles and environment without inline editors", async () => {
    flushSync(() => root.render(<Harness />));
    const summary = () => document.body.querySelector<HTMLElement>('[data-testid="v3-project-context"]');
    await vi.waitFor(() => expect(summary()?.textContent).toContain("결정은 근거와 함께 기록한다."));
    const rows = [...summary()!.querySelectorAll("dt")].map((term) => term.textContent);
    expect(rows).toEqual(["지침", "참고 자료", "기본 실행 환경"]);
    expect(summary()!.textContent).toContain("프론트엔드 아키텍처");
    await vi.waitFor(() => expect(summary()!.textContent).toContain("로젤린 · sample-node · Sol"));
    expect(summary()!.textContent).not.toMatch(/depth|titlesOnly|\bon\b|\boff\b/);
    expect(summary()!.querySelectorAll("button")).toHaveLength(1);
  });

  it("opens the folder settings dialog with that folder's values from 「설정」", async () => {
    flushSync(() => root.render(<Harness />));
    await vi.waitFor(() => expect(document.body.querySelector('button[aria-label="설정"]')).toBeTruthy());
    flushSync(() => document.body.querySelector<HTMLButtonElement>('button[aria-label="설정"]')!.click());
    await vi.waitFor(() => expect(document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="지침"]')?.value).toBe("결정은 근거와 함께 기록한다."));
    expect(document.body.querySelector<HTMLInputElement>('input[aria-label="이름"]')?.value).toBe("앰버");
    expect(document.body.querySelector('[data-section="references"]')?.textContent).toContain("프론트엔드 아키텍처");
  });
});
