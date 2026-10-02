import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { installV3VisualQaRoutes } from './v3-visual-fixtures';

const output = path.resolve('../.local/artifacts/20261002-compact-card-debug');
const cardId = '860fe149-ae89-46bd-bb3e-b6115229edba';
const previewText = '담당 카드 현황 매 턴 주입·외부 변경 알림 · 실행 중';

for (const width of [1440, 390]) {
  test(`prepared card preview uses the existing caption directly after its input at ${width}`, async ({ page }) => {
    mkdirSync(output, { recursive: true });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.addInitScript(() => {
      localStorage.setItem('soul-dashboard-theme', 'dark');
      localStorage.setItem('ls.webglGlass', '0');
    });
    await installV3VisualQaRoutes(page);
    await page.route('**/api/auth/config', route => route.fulfill({ json: { authEnabled: false, devModeEnabled: true } }));
    await page.route('**/api/auth/status', route => route.fulfill({ json: { authenticated: true, user: { email: 'qa@example.test', name: 'QA' } } }));

    await page.goto('/components#components-bubbles');
    const comparison = page.getByTestId('jev-caption-comparison');
    await expect(comparison).toBeVisible();
    await comparison.scrollIntoViewIfNeeded();
    const previewRow = comparison.locator('[data-tree-node-id="assigned-card-preview"]');
    await expect(previewRow).toContainText(previewText);
    await expect(previewRow).not.toContainText(cardId);
    await expect(previewRow).toContainText('마지막 보고');
    await expect(previewRow).toContainText('최근 커멘트 이후 보고 없음');
    await expect(previewRow).not.toContainText('지시:');
    await expect(previewRow).not.toContainText('보고:');
    await expect(previewRow).not.toContainText('소비 확인');

    const metrics = await comparison.evaluate(element => {
      const children = [...element.querySelectorAll<HTMLElement>(':scope > [data-tree-node-id]')];
      const preview = element.querySelector<HTMLElement>('[data-tree-node-id="assigned-card-preview"] > div');
      const summary = element.querySelector<HTMLElement>('[data-tree-node-id="jev-sample-summary"] > div');
      if (!preview || !summary) throw new Error('caption comparison nodes are missing');
      const box = (node: HTMLElement) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return { top: rect.top, bottom: rect.bottom, x: rect.x, right: rect.right,
          fontSize: style.fontSize, padding: style.padding, whiteSpace: style.whiteSpace };
      };
      return {
        order: children.map(node => node.dataset.treeNodeId),
        rows: children.slice(0, 3).map(box),
        preview: box(preview),
        summary: box(summary),
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
      };
    });
    expect(metrics.order.slice(0, 3)).toEqual(['assigned-card-input', 'assigned-card-preview', 'jev-sample-answer']);
    expect(metrics.rows[0]!.bottom).toBeLessThanOrEqual(metrics.rows[1]!.top);
    expect(metrics.rows[1]!.bottom).toBeLessThanOrEqual(metrics.rows[2]!.top);
    expect(metrics.preview.fontSize).toBe(metrics.summary.fontSize);
    expect(metrics.preview.padding).toBe(metrics.summary.padding);
    expect(metrics.preview.x).toBe(metrics.summary.x);
    expect(metrics.preview.whiteSpace).toBe('pre-line');
    expect(metrics.documentWidth).toBe(metrics.viewportWidth);
    expect(errors).toEqual([]);
    await comparison.screenshot({
      path: path.join(output, `web-${width}.png`),
      animations: 'disabled',
    });

    await page.goto('http://127.0.0.1:4202/assets/ios-components/?section=chat');
    const nativeSection = page.getByText('기존 caption · 기존 요약과 요청한 Jev 판정 한 줄', { exact: true });
    await nativeSection.scrollIntoViewIfNeeded();
    const nativePreview = page.getByText(new RegExp(previewText)).first();
    await expect(nativePreview).toBeVisible();
    await expect(nativePreview).not.toContainText(cardId);
    await expect(nativePreview).toContainText('마지막 보고 20분 전');
    await expect(nativePreview).toContainText('최근 커멘트 이후 보고 없음');
    await expect(nativePreview).not.toContainText('지시:');
    await expect(nativePreview).not.toContainText('보고:');
    await page.screenshot({
      path: path.join(output, `native-web-preview-${width}.png`),
      animations: 'disabled',
    });
    writeFileSync(
      path.join(output, `layout-${width}.json`),
      `${JSON.stringify({ width, metrics, errors, native: '실제 RN 컴포넌트의 웹 검수 preview이며 iOS 실기기 증거가 아닙니다.' }, null, 2)}\n`,
      'utf8',
    );
  });
}
