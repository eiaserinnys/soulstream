import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

describe("folder context editing contract", () => {
  it("creates and edits folders with one settings form", () => {
    const dialog = read("./ProjectDialog.tsx");

    expect(dialog).toContain("onCreateIdentity(value.title.trim()");
    expect(dialog).toContain("<FolderSettingsForm");
    expect(dialog).toContain("<ReferencePicker");
    expect(dialog).toContain("<ReferenceRows");
  });

  it("keeps the folder page read-only and routes editing to the settings dialog", () => {
    const detail = read("./FolderDetailPane.tsx");
    const sections = read("./FolderWorkspaceSections.tsx");
    const summary = read("./FolderContextSummary.tsx");
    const layout = read("./V3DashboardLayout.tsx");

    expect(detail).toContain("buildFolderSessionContextItems(effectiveContext, contextBlocks, task.page.id, t)");
    expect(sections).toContain("<FolderContextSummary");
    expect(summary).not.toMatch(/Popover|saveProject|deleteProject/);
    expect(layout).toContain('onOpenSettings={() => setChildFolderDialog({ mode: "edit", folder: selectedFolder })}');
    expect(detail).not.toContain("savePageAtomReference");
  });
});
