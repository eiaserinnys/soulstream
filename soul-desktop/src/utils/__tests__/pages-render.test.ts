import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn() }));

import Setup from "../../pages/Setup";
import Settings from "../../pages/Settings";

describe("Setup", () => {
  const html = renderToStaticMarkup(createElement(Setup, { onConnect: () => {} }));

  it("has a single URL input without the fixed https:// badge", () => {
    expect(html.match(/<input/g)).toHaveLength(1);
    expect(html).not.toMatch(/<span[^>]*>\s*https:\/\/\s*<\/span>/);
    expect(html).not.toContain("rounded-l-floor");
    expect(html).not.toContain("rounded-r-floor");
    expect(html).toContain('placeholder="https://soul.example.com"');
  });

  it("explains the scheme rule under the input", () => {
    expect(html).toContain(
      "http:// 나 https:// 를 붙여 적습니다. 빼면 https:// 로 연결합니다.",
    );
  });
});

describe("Settings", () => {
  it("shows the saved server URL with a way back", () => {
    const html = renderToStaticMarkup(
      createElement(Settings, {
        currentUrl: "http://127.0.0.1:4105",
        onSave: () => {},
        onBack: () => {},
      }),
    );
    expect(html).toContain("http://127.0.0.1:4105");
    expect(html).toContain('title="뒤로"');
    expect(html).not.toMatch(/<span[^>]*>\s*https:\/\/\s*<\/span>/);
  });
});
