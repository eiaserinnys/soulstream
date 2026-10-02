import {defineConfig} from '@playwright/test';
import {realpathSync} from 'node:fs';
export default defineConfig({testDir:'./e2e',testMatch:'chatgpt-card-ui.qa.ts',workers:1,retries:0,timeout:60000,
 reporter:'list',outputDir:'../../../.local/artifacts/20261002-chatgpt-card-ui-v3/results',
 use:{baseURL:'http://127.0.0.1:4197',headless:true},webServer:{
 command:`node "${realpathSync('node_modules/vite/bin/vite.js')}" --host 127.0.0.1 --port 4197 --strictPort`,
 url:'http://127.0.0.1:4197',reuseExistingServer:false,env:{VITE_API_BASE:'http://127.0.0.1:5200'},timeout:60000}});
