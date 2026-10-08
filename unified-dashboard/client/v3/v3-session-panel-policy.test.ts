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

  it("replaces the old review surfaces and removes the general-page inspector", () => {
    const layout = read("./V3DashboardLayout.tsx");
    const navigation = read("./V3Navigation.tsx");

    expect(layout).toContain("V3SessionPanel");
    expect(layout).not.toContain("V3StandaloneDocumentInspector");
    expect(layout).not.toContain("ReviewQueuePanel");
    expect(layout).not.toContain("V3StandaloneInspector");
    expect(navigation).not.toContain("검수 대기");
  });

  it("hides the right panel on the existing mobile breakpoint", () => {
    const styles = read("./v3-planner.css");
    const panelBreakpoint = styles.match(/@media \(max-width: 1180px\) \{([\s\S]*?)^\}/m);
    const mobileBreakpoint = styles.match(/@media \(max-width: 760px\) \{([\s\S]*?)^\}/m);

    expect(panelBreakpoint).not.toBeNull();
    expect(mobileBreakpoint).not.toBeNull();

    const panelRule = panelBreakpoint?.[1].match(
      /\.v3-session-panel,\s*\.v3-session-panel-resize\s*\{([^}]*)\}/,
    );
    expect(panelRule).not.toBeNull();
    expect(panelRule?.[1]).toMatch(/\bdisplay:\s*none\s*;/);

    expect(mobileBreakpoint?.[1]).toMatch(
      /\.v3-navigation,\s*\.v3-navigation-resize\s*\{\s*display:\s*none\s*;/,
    );
    expect(mobileBreakpoint?.[1]).toMatch(/\.v3-shell\s*\{[^}]*display:\s*block;[^}]*height:\s*100dvh;/s);
    expect(mobileBreakpoint?.[1]).toMatch(/\.v3-main\s*\{[^}]*height:\s*calc\(100dvh\s*-\s*58px\)/s);
    expect(mobileBreakpoint?.[1]).not.toMatch(/\.v3-session-panel(?:-resize)?\s*\{/);
  });

  it("routes global search selection through the canonical session panel opener", () => {
    const layout = read("./V3DashboardLayout.tsx");
    const controller = read("./use-v3-session-panel-controller.ts");

    expect(layout).toContain("onOpenSession={sessionPanel.openSessionById}");
    expect(controller).toContain("const openSessionForRequest = useCallback");
    expect(controller).toContain("return openSessionForRequest(session, requestSequence)");
    expect(controller).toContain("const opened = await openSessionForRequest(session, requestSequence)");
  });
});
