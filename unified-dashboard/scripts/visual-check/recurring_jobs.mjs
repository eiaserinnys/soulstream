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
async function measureListHeader(page, tab, outputFile) {
  await page.evaluate(() => document.fonts.ready);
  await tab.locator('aside').scrollIntoViewIfNeeded();
  const measurement = await tab.evaluate(element => {
    const aside = element.querySelector('aside');
    const heading = aside.firstElementChild;
    const paragraph = heading.querySelector('p');
    const rect = e => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
    const linesFor = element => {
      const lines = [];
      const node = element.firstChild;
      for (let i = 0; i < node.textContent.length; i++) {
        const range = document.createRange();
        range.setStart(node, i); range.setEnd(node, i + 1);
        const box = range.getBoundingClientRect();
        const line = lines.find(item => Math.abs(item.top - box.top) < 1);
        if (line) line.text += node.textContent[i];
        else lines.push({ top: box.top, text: node.textContent[i] });
      }
      return lines;
    };
    const detail = document.querySelector('.config-dialog .config-detail-heading p');
    const dialogDescription = document.querySelector('.config-dialog [data-slot="dialog-description"]');
    const dialogHeader = document.querySelector('.config-dialog > [data-slot="dialog-header"]');
    return { list: rect(aside), heading: rect(heading), actions: [...heading.lastElementChild.children].map(rect),
      listContent: rect(heading.nextElementSibling), paragraph: rect(paragraph), lines: linesFor(paragraph),
      wordBreak: getComputedStyle(paragraph).wordBreak, overflowWrap: getComputedStyle(paragraph).overflowWrap,
      detailLines: detail && linesFor(detail), detailWordBreak: detail && getComputedStyle(detail).wordBreak,
      dialogHeader: rect(dialogHeader), dialogDescription: rect(dialogDescription),
      dialogDescriptionLines: linesFor(dialogDescription), dialogDescriptionWordBreak: getComputedStyle(dialogDescription).wordBreak,
      dialogDescriptionOverflowWrap: getComputedStyle(dialogDescription).overflowWrap };
  });
  await page.screenshot({ path: outputFile, animations: 'disabled' });
  return measurement;
}
// 세라피엘의 flush.mjs와 같은 방식으로 실제 스크롤 조상을 찾고 칸의 보이는 끝과 견준다.
async function measureInset(locator, operation = 'measure') {
  return locator.evaluate((element, operation) => {
    let scroller = element.parentElement;
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
    if (!scroller) throw new Error('스크롤 칸을 찾지 못했습니다');
    if (operation === 'end') scroller.scrollTop = scroller.scrollHeight;
    if (operation === 'edge') scroller.scrollTop += element.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom + 4;
    const box = element.getBoundingClientRect();
    const pane = scroller.getBoundingClientRect();
    return { inset: pane.bottom - box.bottom, topInset: box.top - pane.top, paneBottom: pane.bottom, bottom: box.bottom, scroller: scroller.className, scrollPadding: getComputedStyle(scroller).scrollPaddingBlockEnd };
  }, operation);
}
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
    let releaseSave;
    let saveGate;
    await page.route('**/api/recurring-jobs**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname.endsWith('/runs')) return route.fulfill({ json: { runs } });
      if (url.pathname === '/api/recurring-jobs' && request.method() === 'GET') {
        await gate;
        return route.fulfill({ json: { jobs: [job] } });
      }
      if ((url.pathname === '/api/recurring-jobs' && request.method() === 'POST') || (url.pathname.endsWith(job.job_id) && request.method() === 'PATCH')) {
        if (saveGate) await saveGate;
        return route.fulfill({ status: 500, json: { detail: '저장하지 못했습니다. 다시 시도해 주세요.' } });
      }
      return route.fulfill({ json: { job } });
    });
    await page.goto(base);
    const opener = page.getByRole('button', { name: '설정', exact: true });
    await opener.waitFor({ state: 'visible', timeout: 60000 });
    await opener.click();
    const dialog = page.locator('.config-dialog');
    await dialog.getByRole('button', { name: '반복 작업', exact: true }).click();
    const tab = page.getByTestId('recurring-jobs-tab');
    await tab.waitFor({ state: 'visible' });
    const loading = { status: await tab.getByRole('status').count(), active: await tab.getByText('활성', { exact: true }).count(), empty: await tab.getByText('없음', { exact: true }).count() };
    await page.screenshot({ path: path.join(output, `loading-${width}.png`), animations: 'disabled' });
    release();
    await tab.getByText('활성', { exact: true }).waitFor();
    const listHeader = await measureListHeader(page, tab, path.join(output, `recurring-header-${width}.png`));
    await tab.getByLabel('작업 이름').fill('검수용 새 반복 작업');
    const create = tab.getByRole('button', { name: '반복 작업 생성', exact: true });
    await measureInset(create, 'end');
    const rest = await measureInset(create.locator('..'));
    await create.click();
    const alert = tab.getByRole('alert');
    await alert.waitFor({ state: 'attached' });
    await page.waitForTimeout(300);
    const createAlert = await measureInset(alert);
    await page.screenshot({ path: path.join(output, `create-error-${width}.png`), animations: 'disabled' });
    await tab.getByRole('button').filter({ hasText: job.name }).first().click();
    await tab.getByText('최근 실행', { exact: true }).waitFor();
    const save = tab.getByRole('button', { name: '변경 저장', exact: true });
    saveGate = new Promise(resolve => { releaseSave = resolve; });
    await tab.getByRole('button', { name: '다음 5회 보기', exact: true }).focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    const busyButton = tab.getByText('저장 중...', { exact: true });
    await busyButton.waitFor();
    await page.waitForTimeout(150);
    const busyFocus = await busyButton.evaluate(element => {
      const style = getComputedStyle(element);
      return { focused: document.activeElement === element, focusVisible: element.matches(':focus-visible'), activeTag: document.activeElement?.tagName, opacity: style.opacity, shadow: style.boxShadow, insetShadow: style.getPropertyValue('--tw-inset-shadow'), beforeShadow: getComputedStyle(element, '::before').boxShadow };
    });
    await page.screenshot({ path: path.join(output, `busy-focus-${width}.png`), animations: 'disabled' });
    releaseSave();
    await alert.waitFor({ state: 'attached' });
    await page.waitForTimeout(300);
    const failureFocus = await save.evaluate(element => ({ focused: document.activeElement === element, focusVisible: element.matches(':focus-visible'), activeTag: document.activeElement?.tagName }));
    await page.screenshot({ path: path.join(output, `save-failure-focus-${width}.png`), animations: 'disabled' });
    saveGate = undefined;
    await measureInset(save, 'edge');
    await save.click();
    await alert.waitFor({ state: 'attached' });
    await page.waitForTimeout(300);
    const saveAlert = await measureInset(alert);
    const saveButton = await measureInset(save);
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
    result[width] = { listHeader, loading, rest, createAlert, saveAlert, saveButton, geometry, focusAfterSave, busyFocus, failureFocus, tabStops, resize, scrollBeforeResize, originalName, overflow, closed, restored };
    await context.close();

    // 공용 틀을 쓰는 영구 세션의 배치와 scrollIntoView 오류도 같은 전후 조건에서 잰다.
    const persistentContext = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: 'dark', reducedMotion: 'reduce', serviceWorkers: 'block' });
    const persistentPage = await persistentContext.newPage();
    await persistentPage.addInitScript(() => localStorage.setItem('ls.webglGlass', '0'));
    await installV3VisualQaRoutes(persistentPage, { unifiedFolderView: true, timelineEventCount: 1 });
    await persistentPage.route('**/api/auth/config', route => route.fulfill({ json: { authEnabled: true, devModeEnabled: false } }));
    await persistentPage.route('**/api/auth/status', route => route.fulfill({ json: { authenticated: true, user: { email: 'qa@example.test', name: 'QA', isAdmin: true } } }));
    const settings = { default_model: { model_preset: 'qa-standard', reasoning_effort: null }, fallback_models: [], show_generation_separator: true, show_character: true, animate_character: true, show_jev_candidates: true, show_turn_usage: true, turn_usage_mode: 'collapsed' };
    const session = { session_id: 'operations-session', display_name: '운영 기록을 확인하는 영구 세션', node_id: 'eiaserinnys', folder_id: 'folder-amber', agent_id: 'seosoyoung', agent_name: '서소영', persistent: true, settings, runtime: { current_model: { model_preset: 'qa-standard', reasoning_effort: null, model: 'qa-standard' }, pending: null } };
    await persistentPage.route('**/api/persistent-sessions**', route => route.fulfill({ json: { sessions: [session], total: 1, create_defaults: { node_id: 'eiaserinnys', preferred_agent_id: 'seosoyoung', settings, initial_instruction: '', unavailable_reason: null } } }));
    await persistentPage.goto(base);
    await persistentPage.getByRole('button', { name: '설정', exact: true }).click();
    await persistentPage.locator('.config-dialog').getByRole('button', { name: '영구 에이전트 세션', exact: true }).click();
    const persistentTab = persistentPage.getByTestId('persistent-sessions-tab');
    await persistentTab.getByRole('button').filter({ hasText: session.display_name }).first().click();
    const persistentName = persistentTab.getByLabel('세션 이름');
    await persistentName.waitFor();
    const persistentListHeader = await measureListHeader(persistentPage, persistentTab, path.join(output, `persistent-header-${width}.png`));
    const layout = await persistentTab.evaluate(element => {
      const rect = e => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
      return { list: rect(element.querySelector('aside')), detail: rect(element.querySelector(':scope > div')), header: rect(element.querySelector('header')) };
    });
    await persistentPage.screenshot({ path: path.join(output, `persistent-layout-${width}.png`), animations: 'disabled' });
    await persistentName.fill('');
    const persistentSave = persistentTab.getByRole('button', { name: '변경 저장', exact: true });
    await measureInset(persistentSave, 'edge');
    await persistentSave.click();
    const persistentAlert = persistentTab.getByRole('alert').filter({ hasText: '세션 이름을 입력하세요.' });
    await persistentAlert.waitFor({ state: 'attached' });
    await persistentPage.waitForTimeout(300);
    const persistentError = await measureInset(persistentAlert);
    await persistentPage.screenshot({ path: path.join(output, `persistent-error-${width}.png`), animations: 'disabled' });
    result[width].persistent = { listHeader: persistentListHeader, layout, error: persistentError };
    await persistentContext.close();
  }
} finally { await browser.close(); }
await writeFile(path.join(output, 'measurements.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (mode === 'after') {
  for (const entry of Object.values(result)) {
    if (entry.loading.status !== 1 || entry.loading.active || entry.loading.empty) throw new Error('첫 로딩 상태 실패');
    if (!entry.busyFocus.focused || !entry.busyFocus.focusVisible || !entry.failureFocus.focused || !entry.failureFocus.focusVisible) throw new Error('저장 처리 중 또는 실패 뒤 키보드 초점 실패');
    const g = entry.geometry;
    if (g.top < g.rowBottom - 1 || Math.abs(entry.createAlert.inset - 24) > 1 || Math.abs(entry.saveAlert.inset - 24) > 1 || entry.saveButton.inset < 0 || entry.saveButton.topInset < 0) throw new Error('스크롤 칸 안의 오류 안내 위치 실패');
    if (entry.persistent.error.inset < 23 || entry.persistent.error.topInset < 23) throw new Error('영구 세션 오류 안내가 스크롤 칸 끝에 닿습니다');
    if (!entry.tabStops.every(stop => stop.inDialog && stop.visible) || !entry.closed || !entry.restored) throw new Error('키보드 조작 실패');
    if (entry.resize.name !== entry.originalName || entry.overflow.documentScrollWidth > entry.overflow.clientWidth + 1) throw new Error('크기 변경 실패');
  }
}
