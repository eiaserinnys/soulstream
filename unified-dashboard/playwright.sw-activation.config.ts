import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'sw-activation.e2e.ts', workers: 1, retries: 0, timeout: 60_000,
  reporter: [['list']], outputDir: '../../../.local/artifacts/20261001-sw-activation/results',
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:4199', serviceWorkers: 'allow', trace: 'retain-on-failure' },
  webServer: { command: 'node e2e/sw-activation.server.mjs', url: 'http://127.0.0.1:4199', reuseExistingServer: false, timeout: 60_000 },
});
