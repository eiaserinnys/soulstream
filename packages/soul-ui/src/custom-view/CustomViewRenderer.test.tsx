import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CUSTOM_VIEW_CSP,
  CUSTOM_VIEW_FRAME_ORIGINS,
  CustomViewIframe,
  renderCustomViewFragment,
  renderCustomViewSrcDoc,
} from "./CustomViewRenderer";

describe("CustomViewRenderer", () => {
  it("renders a sandboxed iframe without same-origin access", () => {
    const markup = renderToStaticMarkup(createElement(CustomViewIframe, {
      html: "<main></main>",
      title: "Demo",
    }));

    expect(markup).toContain('sandbox="allow-scripts"');
    expect(markup).not.toContain("allow-same-origin");
  });

  it("injects the strict custom view CSP into srcdoc", () => {
    const srcDoc = renderCustomViewSrcDoc("<h1>Demo</h1>");

    expect(srcDoc).toContain("http-equiv=\"Content-Security-Policy\"");
    expect(srcDoc).toContain(CUSTOM_VIEW_CSP);
    expect(CUSTOM_VIEW_FRAME_ORIGINS).toEqual(["https://pages.eiaserinnys.me"]);
    expect(CUSTOM_VIEW_CSP).toContain("frame-src https://pages.eiaserinnys.me;");
    expect(CUSTOM_VIEW_CSP).not.toMatch(/(?:^|; )frame-src https:(?:;|$)/);
  });

  it("escapes whitelisted soul-bind values before srcdoc injection", () => {
    const srcDoc = renderCustomViewSrcDoc(
      '<div><soul-bind kind="runbook-item" id="item-1" field="title"></soul-bind></div>',
      {
        runbookItems: {
          "item-1": {
            title: '<img src=x onerror="alert(1)">',
          },
        },
        runbooks: {},
        sessions: {},
      },
    );

    expect(srcDoc).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(srcDoc).not.toContain('<img src=x onerror="alert(1)">');
  });

  it("ignores non-whitelisted soul-bind fields", () => {
    const html = renderCustomViewFragment(
      '<soul-bind kind="session" id="s1" field="token"></soul-bind>',
      {
        runbookItems: {},
        runbooks: {},
        sessions: {
          s1: {
            title: "Visible",
            status: "running",
          },
        },
      },
    );

    expect(html).toBe("");
  });
});
