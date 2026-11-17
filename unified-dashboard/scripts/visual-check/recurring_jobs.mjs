// 사용법: node --experimental-strip-types unified-dashboard/scripts/visual-check/recurring_jobs.mjs <base-url> <출력 폴더> <before|after>
// 설정 화면의 공통 API는 기존 검수 라우트를 사용하고, 반복 작업은 운영 형태의 별도 데이터로 응답한다.
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { installV3VisualQaRoutes } from '../../e2e/v3-visual-fixtures.ts';

const [base, output, mode] = process.argv.slice(2);
if (!base || !output || !['before', 'after'].includes(mode)) throw new Error('base URL, 출력 폴더, before|after가 필요합니다');
await mkdir(output, { recursive: true });
const job = {
  job_id: 'weekly-operations-report', name: '매주 월요일 운영 기록과 지난주 대화에서 후속 작업을 정리하는 주간 보고',
  prompt: '지난주 운영 기록과 대화에서 처리할 일을 찾아 주간 보고서를 작성합니다.', timezone: 'Asia/Seoul',
  schedule_kind: 'recurring', run_at: null, schedule_expressions: ['0 9 * * 1'], node_id: 'eiaserinnys',
  agent_id: 'seosoyoung', model_preset: null, folderId: 'folder-amber', enabled: true, archived_at: null,
  late_run_window_seconds: 1800, next_run_at: '2026-11-23T00:00:00.000Z', version: 3,
  created_at: '2026-10-20T00:00:00.000Z', updated_at: '2026-11-16T00:00:00.000Z',
};
const runs = ['2026-11-16', '2026-11-09', '2026-11-02'].map((date, index) => ({
  run_id: `weekly-run-${index}`, job_id: job.job_id, trigger: 'scheduled', scheduled_for: `${date}T00:00:00.000Z`,
  session_id: `weekly-session-${index}`, state: 'completed', reason_code: null, reason_message: null,
  job_snapshot: {}, created_at: `${date}T00:00:00.000Z`, started_at: `${date}T00:00:10.000Z`,
  finished_at: `${date}T00:03:00.000Z`, updated_at: `${date}T00:03:00.000Z`,
}));
const browser = await chromium.launch();
const result = {};
try {
  for (const width of [1440, 360]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: 'dark', reducedMotion: 'reduce', serviceWorkers: 'block' });
    const page = await context.newPage();
    await page.addInitScript(() => localStorage.setItem('ls.webglGlass', '0'));
    await installV3VisualQaRoutes(page, { unifiedFolderView: true, timelineEventCount: 1 });
    await page.route('**/api/auth/config', route => route.fulfill({ json: { authEnabled: true, devModeEnabled: false } }));
    await page.route('**/api/auth/status', route => route.fulfill({ json: { authenticated: true, user: { email: 'qa@example.test', name: 'QA', isAdmin: true } } }));
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/recurring-jobs**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname.endsWith('/runs')) return route.fulfill({ json: { runs } });
      if (url.pathname === '/api/recurring-jobs' && request.method() === 'GET') {
        await gate;
        return route.fulfill({ json: { jobs: [job] } });
      }
      if ((url.pathname === '/api/recurring-jobs' && request.method() === 'POST') || (url.pathname.endsWith(job.job_id) && request.method() === 'PATCH')) {
        return route.fulfill({ status: 500, json: { detail: '저장하지 못했습니다. 다시 시도해 주세요.' } });
      }
      return route.fulfill({ json: { job } });
    });
    await page.goto(base);
    const opener = page.getByRole('button', { name: '서버 설정', exact: true });
    await opener.waitFor({ state: 'visible', timeout: 60000 });
    await opener.click();
    const dialog = page.locator('.config-dialog');
    await dialog.getByRole('button', { name: '반복 작업', exact: true }).click();
    const tab = page.getByTestId('recurring-jobs-tab');
    await tab.waitFor({ state: 'visible' });
    const loading = { status: await tab.getByRole('status').count(), active: await tab.getByText('활성', { exact: true }).count(), empty: await tab.getByText('없음', { exact: true }).count() };
    await page.screenshot({ path: path.join(output, `loading-${width}.png`), animations: 'disabled' });
    release();
    await tab.getByRole('button').filter({ hasText: job.name }).first().click();
    await tab.getByText('최근 실행', { exact: true }).waitFor();
    await tab.locator(':scope > div').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.locator('.config-dialog .config-detail').evaluate(element => { element.scrollTop = element.scrollHeight; });
    const save = tab.getByRole('button', { name: '변경 저장', exact: true });
    await save.scrollIntoViewIfNeeded();
    await save.click();
    const alert = tab.getByRole('alert');
    await alert.waitFor({ state: 'attached' });
    await page.waitForTimeout(150);
    const geometry = await alert.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const row = element.previousElementSibling.getBoundingClientRect();
      const detail = element.parentElement.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, rowBottom: row.bottom, rowLeft: row.left, rowRight: row.right, detailLeft: detail.left, detailRight: detail.right, viewportHeight: innerHeight };
    });
    const focusAfterSave = await page.evaluate(() => ({ tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent?.trim().slice(0, 60), inDialog: Boolean(document.activeElement?.closest('.config-dialog')) }));
    await page.screenshot({ path: path.join(output, `save-error-${width}.png`), animations: 'disabled' });
    const tabStops = [];
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      tabStops.push(await page.evaluate(() => ({ label: document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent?.trim().slice(0, 60), inDialog: Boolean(document.activeElement?.closest('.config-dialog')), visible: document.activeElement instanceof HTMLElement && document.activeElement.offsetParent !== null })));
    }
    const originalName = await tab.getByLabel('작업 이름').inputValue();
    const scrollBeforeResize = await page.locator('.config-dialog .config-detail').evaluate(element => element.scrollTop);
    await page.setViewportSize({ width: width === 1440 ? 360 : 1440, height: 1000 });
    await page.waitForTimeout(100);
    const resize = await tab.evaluate(element => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, name: element.querySelector('input[aria-label="작업 이름"]').value, scrollTop: element.querySelector(':scope > div').scrollTop }));
    resize.outerScrollTop = await page.locator('.config-dialog .config-detail').evaluate(element => element.scrollTop);
    const overflow = await page.evaluate(() => ({ documentScrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    await tab.getByLabel('작업 이름').focus();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    const closed = await dialog.isHidden();
    const restored = await opener.evaluate(element => element === document.activeElement);
    result[width] = { loading, geometry, focusAfterSave, tabStops, resize, scrollBeforeResize, originalName, overflow, closed, restored };
    await context.close();
  }
} finally { await browser.close(); }
await writeFile(path.join(output, 'measurements.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (mode === 'after') {
  for (const entry of Object.values(result)) {
    if (entry.loading.status !== 1 || entry.loading.active || entry.loading.empty) throw new Error('첫 로딩 상태 실패');
    const g = entry.geometry;
    if (g.top < g.rowBottom - 1 || g.top < 0 || g.bottom > g.viewportHeight) throw new Error('오류 안내 위치 실패');
    if (!entry.tabStops.every(stop => stop.inDialog && stop.visible) || !entry.closed || !entry.restored) throw new Error('키보드 조작 실패');
    if (entry.resize.name !== entry.originalName || entry.overflow.documentScrollWidth > entry.overflow.clientWidth + 1) throw new Error('크기 변경 실패');
  }
}
