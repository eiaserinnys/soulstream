import { defineConfig } from '@playwright/test';
import completed from './playwright.completed-cards.config';

export default defineConfig({ ...completed, testMatch: 'completed-filter-wrap.e2e.ts',
  webServer: { ...completed.webServer as object,
    command: `node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4207 --strictPort${process.env.COMPLETED_FILTER_BASELINE === '1' ? ' --outDir ../../../.local/artifacts/20261002-completed-card-browser/wrap-baseline' : ''}`,
  },
});
