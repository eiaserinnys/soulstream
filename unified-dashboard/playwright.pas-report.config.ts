import { defineConfig } from '@playwright/test';
import smoke from './playwright.smoke.config';
export default defineConfig({ ...smoke, testMatch: 'persistent-report.e2e.ts', workers: 1, timeout: 90_000,
  use: { ...smoke.use, launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } },
  outputDir: '../../../.local/artifacts/pas-report-web-r2/results',
  webServer: { ...smoke.webServer, reuseExistingServer: false, env: { VITE_API_BASE: 'http://127.0.0.1:9' } } });
