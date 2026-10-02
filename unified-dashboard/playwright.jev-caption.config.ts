import { defineConfig, devices } from '@playwright/test';
import { realpathSync } from 'node:fs';
export default defineConfig({
  testDir:'./e2e',testMatch:'jev-caption.e2e.ts',workers:1,retries:0,timeout:60_000,
  reporter:[['list']],outputDir:'../../../.local/artifacts/20261002-jev-card-turn-observation/results',
  use:{...devices['Desktop Chrome'],baseURL:'http://127.0.0.1:4198'},
  webServer:[{
    command:`node "${realpathSync('node_modules/vite/bin/vite.js')}" --host 127.0.0.1 --port 4198 --strictPort`,
    url:'http://127.0.0.1:4198',reuseExistingServer:false,timeout:60_000,
    env:{VITE_API_BASE:'http://127.0.0.1:5200'},
  },{
    command:'python3 -m http.server 4199 --bind 127.0.0.1 --directory dist',
    url:'http://127.0.0.1:4199/assets/ios-components/',reuseExistingServer:false,timeout:30_000,
  }],
});
