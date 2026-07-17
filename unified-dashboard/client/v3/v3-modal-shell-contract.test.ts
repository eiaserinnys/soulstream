import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const V3_DIRECTORY = new URL("./", import.meta.url);
const SHARED_DASHBOARD_DIRECTORY = new URL("../components/", import.meta.url);
const SOUL_UI_COMPONENTS_DIRECTORY = new URL("../../../packages/soul-ui/src/components/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const expectedV3DialogConsumers = [
  "NewTaskForm.tsx",
  "ProjectDialog.tsx",
  "RitualModal.tsx",
  "SessionSuccessionModal.tsx",
  "TaskProjectMoveDialog.tsx",
  "TaskRunHistory.tsx",
  "V3ContextMenu.tsx",
  "V3Navigation.tsx",
] as const;

const sharedV3DialogConsumers = [
  "../components/ConfigModal.tsx",
  "../components/SearchModal.tsx",
  "../components/UserManagementTab.tsx",
] as const;

const soulUiDialogConsumers = [
  "../../../packages/soul-ui/src/components/FolderContextMenu.tsx",
  "../../../packages/soul-ui/src/components/FolderDialog.tsx",
  "../../../packages/soul-ui/src/components/FolderSettingsDialog.tsx",
  "../../../packages/soul-ui/src/components/NewSessionDialog.tsx",
  "../../../packages/soul-ui/src/components/RenameSessionDialog.tsx",
  "../../../packages/soul-ui/src/components/SessionContextMenu.tsx",
] as const;

function dialogPopupConsumers(directory: URL, prefix: string): string[] {
  return readdirSync(directory)
    .filter((fileName) => fileName.endsWith(".tsx"))
    .filter((fileName) => readFileSync(new URL(fileName, directory), "utf8").includes("<DialogPopup"))
    .map((fileName) => `${prefix}${fileName}`);
}

describe("v3 modal shell contract", () => {
  it("enumerates every shared DialogPopup consumer used by the dashboard surfaces", () => {
    const actual = [
      ...dialogPopupConsumers(V3_DIRECTORY, ""),
      ...dialogPopupConsumers(SHARED_DASHBOARD_DIRECTORY, "../components/"),
      ...dialogPopupConsumers(SOUL_UI_COMPONENTS_DIRECTORY, "../../../packages/soul-ui/src/components/"),
    ].sort();

    expect(actual).toEqual([
      ...expectedV3DialogConsumers,
      ...sharedV3DialogConsumers,
      ...soulUiDialogConsumers,
    ].sort());
  });

  it.each([...expectedV3DialogConsumers, ...sharedV3DialogConsumers, ...soulUiDialogConsumers])(
    "%s delegates its modal surface to the common DialogPopup",
    (path) => {
      const source = read(path.startsWith("../") ? path : `./${path}`);

      expect(source).toContain("<DialogPopup");
      expect(source).not.toContain("LiquidGlassLayer");
      expect(source).not.toContain("liquidGlassStyle");
    },
  );

  it("keeps only mobile context menus on the explicit bottom-sheet exception", () => {
    expect(read("./V3ContextMenu.tsx")).toContain("bottomStickOnMobile");
    expect(read("../../../packages/soul-ui/src/components/FolderContextMenu.tsx")).toContain("bottomStickOnMobile");
    expect(read("../../../packages/soul-ui/src/components/SessionContextMenu.tsx")).toContain("bottomStickOnMobile");
  });

  it("does not override the common glass corner radius in v3 modal styles", () => {
    expect(read("./v3-context-succession.css")).not.toMatch(
      /\.v3-succession-modal\s*\{[^}]*border-radius/s,
    );
    expect(read("./ritual.css")).not.toMatch(/\.v3-ritual-modal\s*\{[^}]*border-radius/s);
  });

  it("orders the new-session sections and exposes the bounded document preview", () => {
    const source = read("./SessionSuccessionModal.tsx");
    const sectionLabels = ["노드 / 에이전트", "컨텍스트", "추가 지침", "초기 지시"];

    expect(sectionLabels.map((label) => source.indexOf(label))).toEqual(
      [...sectionLabels].map((label) => source.indexOf(label)).sort((left, right) => left - right),
    );
    expect(source).not.toContain("기본 지침");
    expect(source).not.toContain("실행 에이전트");
    expect(source).toContain("buildSessionInitiationPrompt(initialInstruction)");
    expect(read("./v3-context-succession.css")).toMatch(
      /\.v3-succession-document-options\s*\{[^}]*max-height:[^}]*overflow-y:\s*auto/s,
    );
  });
});
