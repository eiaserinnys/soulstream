/**
 * @vitest-environment jsdom
 */

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { MobileProjectList } from "./MobileProjectList";

describe("MobileProjectList", () => {
  it("shows the recursive project order and enters through the selected folder", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onSelect = vi.fn();
    const folders = [
      folder("child", "대시보드", "root"),
      folder("ops", "운영", null),
      folder("root", "소울스트림", null),
    ];

    flushSync(() => root.render(<MobileProjectList folders={folders} onSelect={onSelect} />));
    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      "📂소울스트림",
      "↳대시보드",
      "📂운영",
    ]);
    expect(buttons[1]?.style.getPropertyValue("--v3-mobile-project-depth")).toBe("1");

    buttons[1]?.click();
    expect(onSelect).toHaveBeenCalledWith(folders[0]);

    flushSync(() => root.unmount());
    container.remove();
  });
});

function folder(id: string, name: string, parentFolderId: string | null) {
  return { id, name, parentFolderId, sortOrder: 0, projectPageId: `project-${id}` };
}
