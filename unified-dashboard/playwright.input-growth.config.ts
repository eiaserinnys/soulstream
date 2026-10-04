import { defineConfig } from '@playwright/test';
import { realpathSync } from 'node:fs';
export default defineConfig({
  testDir: './e2e', testMatch: 'input-growth.e2e.ts', workers: 1, retries: 0,
  timeout: 120_000, reporter: [['list']],
  outputDir: '../../../.local/artifacts/20261004-input-growth/results',
  use: { baseURL: 'http://127.0.0.1:4327', actionTimeout: 10_000 },
  webServer: {
    command: `node "${realpathSync('node_modules/vite/bin/vite.js')}" --host 127.0.0.1 --port 4327 --strictPort`,
    url: 'http://127.0.0.1:4327', reuseExistingServer: false,
    env: { VITE_API_BASE: 'http://127.0.0.1:5200' }, timeout: 60_000,
  },
});
