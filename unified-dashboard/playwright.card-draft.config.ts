import {defineConfig,devices} from '@playwright/test';
import {realpathSync} from 'node:fs';
export default defineConfig({testDir:'./e2e',testMatch:'card-draft.e2e.ts',workers:1,retries:0,timeout:60000,reporter:'list',
 outputDir:'../../../.local/artifacts/20261004-card-draft/results',use:{...devices['Desktop Chrome'],baseURL:'http://127.0.0.1:4207',trace:'off'},
 webServer:{command:`node "${realpathSync('node_modules/vite/bin/vite.js')}" --host 127.0.0.1 --port 4207 --strictPort`,url:'http://127.0.0.1:4207',reuseExistingServer:false,timeout:60000,env:{VITE_API_BASE:'http://127.0.0.1:5200'}}});
