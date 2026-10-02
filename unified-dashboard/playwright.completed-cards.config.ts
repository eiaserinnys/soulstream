import {defineConfig} from '@playwright/test';
import {realpathSync} from 'node:fs';
const baseline=process.env.COMPLETED_BASELINE==='1';
export default defineConfig({testDir:'./e2e',testMatch:'completed-card-browser.e2e.ts',workers:1,retries:0,timeout:60000,reporter:'list',
 outputDir:'../../../.local/artifacts/20261002-completed-card-browser/playwright-results',
 use:{baseURL:'http://127.0.0.1:4207',trace:'retain-on-failure'},
 webServer:{command:`node "${realpathSync('node_modules/vite/bin/vite.js')}" preview --host 127.0.0.1 --port 4207 --strictPort${baseline?' --outDir ../../../.local/artifacts/20261002-completed-card-browser/baseline-web':''}`,
 env:{VITE_API_BASE:'http://127.0.0.1:5200'},url:'http://127.0.0.1:4207',reuseExistingServer:false,timeout:60000}});
