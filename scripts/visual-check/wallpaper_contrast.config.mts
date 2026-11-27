import { defineConfig } from "../../unified-dashboard/node_modules/@playwright/test/index.mjs";

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "wallpaper_contrast.spec.mts",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  timeout: 240_000,
  expect: { timeout: 20_000 },
  outputDir: `${process.env.REVIEW_OUT ?? "/tmp/wallpaper-contrast"}/pw-results`,
  use: {
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    serviceWorkers: "block",
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    reducedMotion: "reduce",
  },
});
