/** @type {import('@playwright/test').PlaywrightTestConfig} */
module.exports = {
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 60000,
  use: {
    headless: true,
    baseURL: "http://localhost:5200",
    viewport: { width: 1280, height: 800 },
  },
  reporter: [["list"]],
};
