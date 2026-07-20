import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("v3 right session panel policy", () => {
  it("projects the existing session stream without panel polling or fan-out", () => {
    const panel = read("./V3SessionPanel.tsx");
    const livePlane = read("./use-v3-live-data-plane.ts");

    expect(panel).not.toMatch(/\bfetch\s*\(/);
    expect(panel).not.toContain("setInterval");
    expect(livePlane).toContain('event.type !== "session_list"');
    expect(livePlane).toContain("projectSessionListSnapshot");
  });

  it("replaces the old review surfaces and keeps the document-only inspector", () => {
    const layout = read("./V3DashboardLayout.tsx");
    const navigation = read("./V3Navigation.tsx");

    expect(layout).toContain("V3SessionPanel");
    expect(layout).toContain("V3StandaloneDocumentInspector");
    expect(layout).not.toContain("ReviewQueuePanel");
    expect(layout).not.toContain("V3StandaloneInspector");
    expect(navigation).not.toContain("검수 대기");
  });

  it("hides the right panel on the existing mobile breakpoint", () => {
    const styles = read("./v3-session-panel.css");
    expect(styles).toContain("@media (max-width: 760px)");
    expect(styles).toMatch(/\.v3-session-panel,[\s\S]*display:\s*none/);
  });

  it("routes global search selection through the canonical session panel opener", () => {
    const layout = read("./V3DashboardLayout.tsx");
    const controller = read("./use-v3-session-panel-controller.ts");

    expect(layout).toContain("onOpenSession={sessionPanel.openSessionById}");
    expect(controller).toContain("await openSession(session)");
  });
});
