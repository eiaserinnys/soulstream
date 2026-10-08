import { execFileSync } from "node:child_process";

import { expect, test } from "@playwright/test";

import {
  assertExpectedLayout,
  baselineOrigin,
  capture,
  captureDialogState,
  createQaPage,
  measureDashboardVisuals,
  measureMainGrid,
  measureStylesheetOrder,
  reverseBuiltCssOrder,
  writeJson,
  type Viewport,
} from "./v3-main-grid-css-185.helpers";

const viewports = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1920x1080", width: 1920, height: 1080 },
  { name: "1180x900", width: 1180, height: 900 },
  { name: "390x844", width: 390, height: 844 },
] as const satisfies readonly Viewport[];

const expectedBaselineBuildSha = "070355e415e87d3dc25d7311107b2a40f0104f77";
const currentDistSourceSha = "62480bc2458a0451d70350466ed171a237ce2d0b";
const evidence = {
  baselineBuildSha: "",
  originMainSha: "",
  currentDistSourceSha,
};

test.describe.configure({ mode: "serial", timeout: 45_000 });

test.beforeAll(async () => {
  const response = await fetch(baselineOrigin + "/api/health", {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("production baseline health check failed");
  const health = await response.json() as { build_id?: unknown };
  evidence.baselineBuildSha = typeof health.build_id === "string" ? health.build_id : "";
  if (evidence.baselineBuildSha !== expectedBaselineBuildSha) {
    throw new Error("production baseline build SHA changed; stop the comparison");
  }

  const remoteMain = execFileSync("git", ["ls-remote", "origin", "refs/heads/main"], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 4_096,
    stdio: ["ignore", "pipe", "ignore"],
  });
  evidence.originMainSha = remoteMain.trim().split(/\s+/)[0] ?? "";
  if (evidence.originMainSha !== expectedBaselineBuildSha) {
    throw new Error("origin/main changed; stop the comparison");
  }
});

for (const viewport of viewports) {
  const reuseTag = viewport.width === 390 ? "" : " @reuse-desktop";

  test("production main grid " + viewport.name + " survives reversed CSS order" + reuseTag, async ({ browser }, testInfo) => {
    const session = await createQaPage(browser, "current", viewport);
    try {
      await session.page.goto("/v3", { waitUntil: "domcontentloaded" });
      await session.page.getByTestId("card-home").waitFor({ state: "visible", timeout: 20_000 });
      await session.page.locator(".v3-planner").waitFor({ state: "visible", timeout: 20_000 });
      const before = await measureMainGrid(session.page);
      assertExpectedLayout(viewport.name, before);
      await capture(session.page, testInfo.outputPath(viewport.name + "-before.png"));

      const order = await reverseBuiltCssOrder(session.page);
      expect(order.indexCssAfterDashboardCss).toBe(true);
      const after = await measureMainGrid(session.page);
      expect(after).toEqual(before);
      assertExpectedLayout(viewport.name, after);
      await capture(session.page, testInfo.outputPath(viewport.name + "-reversed.png"));
      if (viewport.width === 390) {
        await writeJson(testInfo.outputPath("390-reversed.json"), { viewport, before, after, order });
      }
    } finally {
      await session.context.close();
    }
  });
}

test("1440 navigation handle +600 mouse drag reaches the existing max and persists it", async ({ browser }, testInfo) => {
  const viewport = viewports[0];
  const session = await createQaPage(browser, "current", viewport);
  try {
    await session.page.goto("/v3", { waitUntil: "domcontentloaded" });
    await session.page.getByTestId("card-home").waitFor({ state: "visible", timeout: 20_000 });
    await session.page.locator(".v3-planner").waitFor({ state: "visible", timeout: 20_000 });
    const handle = session.page.getByTestId("v3-navigation-resize-handle").locator(":scope > div");
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    const startX = box!.x + box!.width / 2;
    const centerY = box!.y + box!.height / 2;

    await session.page.mouse.move(startX, centerY);
    await session.page.mouse.down();
    await session.page.mouse.move(startX + 600, centerY, { steps: 20 });
    await session.page.mouse.up();

    await expect.poll(async () => {
      const layout = await measureMainGrid(session.page);
      return [layout.navigation.width, layout.planner.width, layout.sessionPanel.width, layout.sessionPanel.right];
    }, { timeout: 8_000 }).toEqual([480, 384, 500, 1418]);
    await expect.poll(() => session.page.evaluate(
      () => localStorage.getItem("soul-ui.dashboard.leftSidebarWidth"),
    ), { timeout: 8_000 }).toBe("480");

    const layout = await measureMainGrid(session.page);
    const savedWidth = await session.page.evaluate(
      () => localStorage.getItem("soul-ui.dashboard.leftSidebarWidth"),
    );
    const screenshot = testInfo.outputPath("1440-nav-max.png");
    await capture(session.page, screenshot);
    await writeJson(testInfo.outputPath("1440-nav-max.json"), {
      viewport,
      pointerDeltaPx: 600,
      layout,
      savedNavigationWidth: savedWidth,
      screenshot,
      apiRequests: session.apiRequests.slice().sort(),
      unknownApiRequests: session.unknownApiRequests,
    });
    expect(session.unknownApiRequests).toEqual([]);
  } finally {
    await session.context.close();
  }
});

test("normal-order production baseline and current dist match with one API fixture at all widths", async ({ browser }, testInfo) => {
  const comparisons = [];
  for (const viewport of viewports) {
    const pair = [];
    for (const label of ["baseline", "current"] as const) {
      const assetOutput = viewport.width === 1440
        ? testInfo.outputPath("assets/" + label)
        : undefined;
      const session = await createQaPage(browser, label, viewport, assetOutput);
      try {
        await session.page.goto("/v3", { waitUntil: "domcontentloaded" });
        await session.page.getByTestId("card-home").waitFor({ state: "visible", timeout: 20_000 });
        await session.page.locator(".v3-planner").waitFor({ state: "visible", timeout: 20_000 });
        const layout = await measureMainGrid(session.page);
        assertExpectedLayout(viewport.name, layout);
        const visual = await measureDashboardVisuals(session.page);
        const apiRequests = session.apiRequests.slice().sort();
        expect(session.unknownApiRequests).toEqual([]);

        const screenshot = testInfo.outputPath(label + "-normal-" + viewport.name + ".png");
        await capture(session.page, screenshot);
        const assets = viewport.width === 1440 ? await session.finishAssetCapture() : [];
        const result = {
          label,
          origin: session.origin,
          viewport,
          baselineBuildSha: evidence.baselineBuildSha,
          originMainSha: evidence.originMainSha,
          currentDistSourceSha: label === "current" ? currentDistSourceSha : null,
          apiFixture: "installV3VisualQaRoutes; unknown API routes abort",
          apiRequests,
          unknownApiRequests: session.unknownApiRequests,
          layout,
          visual,
          stylesheetOrder: await measureStylesheetOrder(session.page),
          assets,
          screenshot,
        };
        await writeJson(testInfo.outputPath(label + "-normal-" + viewport.name + ".json"), result);
        pair.push(result);
      } finally {
        await session.context.close();
      }
    }

    expect(pair[1].layout).toEqual(pair[0].layout);
    expect(pair[1].visual).toEqual(pair[0].visual);
    expect(pair[1].apiRequests).toEqual(pair[0].apiRequests);
    expect(pair[1].unknownApiRequests).toEqual([]);
    expect(pair[0].unknownApiRequests).toEqual([]);
    comparisons.push({ viewport, baseline: pair[0], current: pair[1] });
  }

  await writeJson(testInfo.outputPath("normal-order-baseline-current.json"), {
    baselineOrigin,
    baselineBuildSha: evidence.baselineBuildSha,
    originMainSha: evidence.originMainSha,
    currentDistSourceSha,
    comparison: "baseline/current screen measurements and API fixture request inventory",
    results: comparisons,
  });
});

for (const viewport of [viewports[0], viewports[3]]) {
  test("initial connection failure matches production baseline at " + viewport.name, async ({ browser }, testInfo) => {
    const pair = [];
    for (const label of ["baseline", "current"] as const) {
      pair.push(await captureDialogState(browser, label, viewport, "first", testInfo, evidence));
    }
    expect(pair[1].measurement).toEqual(pair[0].measurement);
    expect(pair[1].initialState).toMatchObject({
      cardHomePresent: false,
      plannerPresent: false,
      lazyDashboardAssetsLoaded: [],
    });
    expect(pair[1].lazyGateExpired).toBe(false);
    await writeJson(testInfo.outputPath("connection-first-" + viewport.name + "-comparison.json"), {
      viewport,
      baselineBuildSha: evidence.baselineBuildSha,
      currentDistSourceSha,
      baseline: pair[0],
      current: pair[1],
    });
  });

  test("loaded connection failure matches production baseline at " + viewport.name, async ({ browser }, testInfo) => {
    const pair = [];
    for (const label of ["baseline", "current"] as const) {
      pair.push(await captureDialogState(browser, label, viewport, "loaded", testInfo, evidence));
    }
    expect(pair[1].measurement).toEqual(pair[0].measurement);
    expect(pair[1].initialState).toMatchObject({ cardHomePresent: true, plannerPresent: true });
    await writeJson(testInfo.outputPath("connection-loaded-" + viewport.name + "-comparison.json"), {
      viewport,
      baselineBuildSha: evidence.baselineBuildSha,
      currentDistSourceSha,
      baseline: pair[0],
      current: pair[1],
    });
  });
}
