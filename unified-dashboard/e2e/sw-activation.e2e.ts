import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const output = path.resolve('../../../.local/artifacts/20261001-sw-activation');
mkdirSync(output, { recursive: true });
async function observe(page: Page) {
  const approvals: string[] = [], errors: string[] = [], navigations: string[] = [];
  page.on('console', message => { if (message.text().startsWith('SW_APPROVAL_STATE:')) approvals.push(message.text().split(':')[1]); });
  page.on('pageerror', error => errors.push(error.message));
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations.push(new URL(frame.url()).pathname); });
  await page.addInitScript(() => {
    localStorage.setItem('ls.webglGlass', '0');
    const postMessage = ServiceWorker.prototype.postMessage;
    ServiceWorker.prototype.postMessage = function(message, ...rest) {
      if (message?.type === 'SOULSTREAM_SW_APPROVE_RELOAD') console.info(`SW_APPROVAL_STATE:${this.state}`);
      return postMessage.call(this, message, ...rest);
    };
  });
  return { approvals, errors, navigations };
}
async function renderedAndActivated(page: Page) {
  await expect(page.getByTestId('components-review')).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state)).toBe('activated');
  await expect(page.locator('body')).toContainText('컴포넌트 검수');
}

test('first installation and current-client update activate before navigation and render', async ({ page, request }) => {
  await request.post('/__test/release', { data: 'current' });
  const record = await observe(page);
  await page.goto('/components', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => record.approvals.length).toBe(1);
  await expect.poll(() => record.navigations.length).toBe(2);
  await renderedAndActivated(page);
  expect(record.approvals).toEqual(['activated']);
  const previousNavigations = record.navigations.length;
  await request.post('/__test/release', { data: 'current' });
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.update());
  await expect.poll(() => record.navigations.length).toBeGreaterThan(previousNavigations);
  await renderedAndActivated(page);
  expect(record.approvals).toEqual(['activated', 'activated']);
  expect(record.errors).toEqual([]);
  await page.screenshot({ path: path.join(output, 'first-install-and-update.png') });
  writeFileSync(path.join(output, 'first-install-and-update.json'), JSON.stringify({ ...record, active: 'activated', rendered: true }, null, 2));
});

test('a previous client can approve immediately without blocking the new worker activation', async ({ page, request }) => {
  await request.post('/__test/release', { data: 'seed' });
  const record = await observe(page);
  await page.goto('/components', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state)).toBe('activated');
  await request.post('/__test/release', { data: 'current' });
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.update());
  await expect.poll(() => record.navigations.length).toBe(2);
  await renderedAndActivated(page);
  expect(record.approvals).toEqual(['activating']);
  expect(record.errors).toEqual([]);
  await page.screenshot({ path: path.join(output, 'previous-client-update.png') });
  writeFileSync(path.join(output, 'previous-client-update.json'), JSON.stringify({ ...record, active: 'activated', rendered: true }, null, 2));
});
