import { expect, test } from '@playwright/test';
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { installChatUiRoutes, chatUiSession } from './chat-ui-fixtures';
import { reportReviewEntries } from '../client/v3/persistent-report-review-data';
import { waitForStableLayout } from './layout-stability';
import { reviewCard } from '../client/v3/components-review-fixtures';

const output = '/home/eias/workspace/.local/artifacts/20261013-270-report-bubble-impl/web';
const sse = (type: string, payload: object, id: number) => `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
test('PAS HTTP/SSE report pager, direct reply/cancellation/failure/retry, latest board and focus', async ({ page }) => {
  mkdirSync(output, { recursive: true });
  for (const file of readdirSync(output)) if (file.endsWith('.png') || file === 'metrics.json') unlinkSync(path.join(output, file));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  const fixture = await installChatUiRoutes(page, { ui: false, count: 3 });
  // Preferences must acknowledge the selected theme rather than restore the fixture default.
  let preferences: Record<string, unknown> = { appearance: 'dark' };
  await page.route('**/api/user/preferences', route => {
    if (route.request().method() !== 'GET') preferences = route.request().postDataJSON();
    return route.fulfill({ json: { preferences, hasBackground: false } });
  });
  const cards = [270, 328, 338].map((number, index) => ({ ...reviewCard,
    id: ['0ef7a7b5-588f-436b-839b-53131aba0a43', '89a431e6-f40b-4164-91b8-9ca5f40b3454', 'd725a58c-b123-4b30-a660-997d57c31e0e'][index],
    number, folderId: 'rb-alpha', title: `보고 카드 ${number}`, assigneeKind: null, assigneeSessionId: null, assigneeAgentId: null }));
  let cardLists = 0;
  const firstCardList = gate(), secondCardList = gate(), thirdCardList = gate();
  const cardDetails: string[] = [];
  await page.route(url => url.pathname === '/api/cards', async route => {
    if (new URL(route.request().url()).searchParams.get('includeCompleted') !== 'true') return route.fulfill({ json: { cards: [] } });
    cardLists++;
    if (cardLists === 1) await firstCardList.promise;
    if (cardLists === 2) await secondCardList.promise;
    if (cardLists === 3) await thirdCardList.promise;
    return route.fulfill({ json: { cards: cards.slice(0, cardLists) } });
  });
  await page.route(url => url.pathname.startsWith('/api/cards/'), route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.slice('/api/cards/'.length));
    cardDetails.push(id);
    const card = cards.find(card => card.id === id);
    // Production treats a number as an unknown ID; never conceal this regression.
    if (!card) return route.fulfill({ status: 404, json: { detail: { error: { code: 'CARD_NOT_FOUND', message: '카드가 없습니다' } } } });
    return route.fulfill({ json: { card, reports: [], questions: [], sessions: [], comments: [], notes: [] } });
  });
  await page.addInitScript(() => localStorage.setItem('soul-dashboard-theme', 'dark'));
  let entries = reportReviewEntries;
  const settings = { default_model: { model_preset: null, reasoning_effort: null }, fallback_model: null, show_generation_separator: true, show_character: true, show_jev_candidates: true, animate_character: false, show_turn_usage: true, turn_usage_mode: 'collapsed' };
  const resource = () => ({ session_id: chatUiSession, display_name: '보고 검수', node_id: 'eiaserinnys', folder_id: 'rb-alpha', agent_id: 'roselin_codex', agent_name: '로젤린', persistent: true, persistent_report: entries, settings, runtime: { current_model: { model_preset: null, reasoning_effort: null, model: 'codex' }, pending: null } });
  const deletes: string[] = [];
  let failDismiss = true;
  const firstDismiss = gate(), secondDismiss = gate();
  await page.route('**/api/persistent-sessions**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (route.request().method() === 'DELETE') {
      const key = pathname.split('/').pop()!; deletes.push(key);
      if (failDismiss) { failDismiss = false; await firstDismiss.promise; return route.fulfill({ status: 503, json: { detail: '검수 내리기 실패' } }); }
      await secondDismiss.promise;
      entries = entries.filter(entry => entry.key !== key);
      return route.fulfill({ json: { ok: true, changed: true, entries: entries.map(({ key, title }) => ({ key, title })), persistent_report: entries } });
    }
    if (pathname === '/api/persistent-sessions') return route.fulfill({ json: { sessions: [resource()], total: 1, create_defaults: { node_id: 'eiaserinnys', preferred_agent_id: 'roselin_codex', settings, initial_instruction: '', unavailable_reason: null } } });
    if (pathname.endsWith('/instructions')) return route.fulfill({ json: { instructions: [] } });
    return route.fulfill({ json: { session: resource() } });
  });
  const updates: { gate: ReturnType<typeof gate>; body: string }[] = [];
  let streamRequest = 0;
  await page.route('**/api/sessions/stream?*', async route => {
    const index = streamRequest++;
    if (index === 0) return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 100\n\n' + sse('session_list', { sessions: [{ agentSessionId: chatUiSession, status: 'running', eventCount: 3, nodeId: 'eiaserinnys', agentId: 'roselin_codex' }], total: 1 }, 1) });
    const update = updates[index - 1] ?? (updates[index - 1] = { gate: gate(), body: '' });
    await update.gate.promise;
    return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 100\n\n' + update.body });
  });
  let updateIndex = 0;
  const publish = (next: typeof entries) => {
    entries = next;
    const update = updates[updateIndex] ?? (updates[updateIndex] = { gate: gate(), body: '' });
    update.body = sse('session_updated', { agent_session_id: chatUiSession, persistent_report: entries }, 10 + updateIndex++);
    update.gate.release();
  };
  const events: { gate: ReturnType<typeof gate>; body: string }[] = [];
  let eventRequest = 0, eventIndex = 0;
  await page.route('**/api/sessions/*/events*', async route => {
    if (eventRequest++ === 0) return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 100\n\n' + sse('history_sync', { last_event_id: 3, is_live: true, status: 'running' }, 3) });
    const index = eventRequest - 2;
    const update = events[index] ?? (events[index] = { gate: gate(), body: '' });
    await update.gate.promise;
    return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 100\n\n' + update.body });
  });
  const echo = (text: string) => {
    const update = events[eventIndex] ?? (events[eventIndex] = { gate: gate(), body: '' });
    update.body = sse('user_message', { text, timestamp: Date.now() / 1000 }, 90 + eventIndex++);
    update.gate.release();
  };
  const sends: Record<string, unknown>[] = [];
  let sendControl = { gate: gate(), fail: true };
  await page.route('**/api/sessions/*/intervene', async route => {
    const body = route.request().postDataJSON(); sends.push(body);
    const control = sendControl; await control.gate.promise;
    if (control.fail) return route.fulfill({ status: 503, json: { detail: '검수 전송 실패' } });
    await route.fulfill({ json: { delivered: true } });
    echo(body.text);
  });
  // The screen survives the portal/inline switch; resolve its current deck each frame.
  const waitForReportLayout = () => waitForStableLayout(page.getByTestId('persistent-session-screen'), ['[data-testid="report-deck"]', '[data-testid="report-deck"] [data-current="true"]']);
  const snapshot = async (name: string) => {
    await page.mouse.move(0, 0); await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await waitForReportLayout();
    await page.screenshot({ path: path.join(output, `${name}.png`) });
  };
  await page.context().route('https://example.test/**', route => route.fulfill({ contentType: 'text/html', body: '<title>보고 출처</title>' }));
  await page.goto(`/persistent/${chatUiSession}`);
  const deck = page.getByTestId('report-deck');
  const track = page.getByTestId('report-track');
  const current = () => deck.locator('[data-current="true"]');
  const editor = page.getByRole('textbox', { name: '메시지', exact: true });
  await expect(deck).toBeVisible(); await expect(editor).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(deck.locator('.pas-report-count')).toHaveText('1 / 3');
  expect(await deck.locator('article[inert][aria-hidden="true"]').count()).toBe(2);
  await snapshot('1440-default');
  const workspace = page.getByTestId('v3-card-workspace');
  const firstCardLink = current().getByRole('link', { name: '카드 270번 열기', exact: true });
  await expect(firstCardLink).not.toHaveAttribute('href');
  await expect.poll(() => cardLists).toBe(1);
  await firstCardLink.click({ modifiers: ['Control'] });
  await firstCardLink.click({ modifiers: ['Meta'] });
  await firstCardLink.click({ button: 'middle' });
  expect(cardLists).toBe(1);
  await expect(workspace).toHaveCount(0);
  firstCardList.release();
  await expect(firstCardLink).toHaveAttribute('href', `/?card=${cards[0].id}`);
  await expect(workspace).toHaveCount(0);
  expect(cardLists).toBe(1); // The successful prefetch remembers the absent numbers.
  // Resolved links retain the browser's native modified-click behavior.
  await expect(firstCardLink).toHaveAttribute('target', '_blank');
  await firstCardLink.click();
  await expect(workspace.getByTestId('card-detail')).toContainText('보고 카드 270');
  await page.screenshot({ path: path.join(output, '1440-card-open.png') });
  await workspace.getByRole('button', { name: '카드 닫기', exact: true }).click();
  await expect(workspace).toHaveCount(0);
  await firstCardLink.focus(); await page.keyboard.press('Enter');
  await expect(workspace.getByTestId('card-detail')).toContainText('보고 카드 270');
  expect(cardLists).toBe(1);
  await workspace.getByRole('button', { name: '카드 닫기', exact: true }).click();
  await expect(workspace).toHaveCount(0);
  await deck.getByRole('button', { name: '다음 장', exact: true }).click();
  await expect(current().getByRole('heading')).toHaveText('블로그 저장소 브랜치 정리');
  // Focus scrolls an anchor into view; let the pager finish its native scroll first.
  await expect.poll(() => track.evaluate(node => Math.abs(node.scrollLeft - node.clientWidth))).toBeLessThan(1);
  await waitForReportLayout();
  const secondCardLink = current().getByRole('link', { name: '카드 328번 열기', exact: true });
  await expect(secondCardLink).not.toHaveAttribute('href');
  await secondCardLink.focus(); await expect(secondCardLink).toBeFocused(); await page.keyboard.press('Enter');
  await expect.poll(() => cardLists).toBe(2);
  await expect(workspace).toHaveCount(0);
  secondCardList.release();
  await expect(workspace.getByTestId('card-detail')).toContainText('보고 카드 328');
  expect(cardLists).toBe(2);
  await workspace.getByRole('button', { name: '카드 닫기', exact: true }).click();
  await expect(workspace).toHaveCount(0);
  await waitForReportLayout();
  const geometry = await current().evaluate(node => ({ height: node.getBoundingClientRect().height, x: node.querySelector('h2')!.getBoundingClientRect().x }));
  await expect(deck).toHaveAttribute('data-bubble', 'true');
  expect((await deck.boundingBox())!.width).toBe(342);
  await expect(deck.locator('.pas-report-kind')).toHaveCount(0);
  await expect(current()).toHaveAttribute('aria-label', /답하실 것/);
  await snapshot('1440-answer');
  await editor.fill('쓰던 글');
  await page.getByTestId('chat-input').locator('input[type=file]').setInputFiles({ name: '메모.pdf', mimeType: 'application/pdf', buffer: Buffer.from('첨부') });
  const attachment = page.getByTestId('chat-input').getByTitle('메모.pdf'); await expect(attachment).toBeVisible();
  await current().getByRole('button', { name: '응', exact: true }).click();
  await expect.poll(() => sends.length).toBe(1);
  await expect(editor).toHaveValue('쓰던 글'); await expect(attachment).toBeVisible();
  await expect(current()).toHaveAttribute('aria-label', /답 받음/);
  await expect(current().getByRole('button', { name: '취소 요청', exact: true })).toHaveCount(0);
  sendControl.gate.release();
  await expect(page.getByRole('button', { name: '다시 보내기', exact: true })).toBeVisible();
  await expect(current()).toHaveAttribute('aria-label', /답하실 것/);
  expect(sends[0]).toMatchObject({ text: '블로그 저장소 브랜치 정리: 응', context_items: [{ key: 'persistent_report_reply', content: { key: 'blog', option: '응' } }] });
  expect(sends[0].attachmentPaths).toBeUndefined();
  sendControl = { gate: gate(), fail: false };
  await page.getByRole('button', { name: '다시 보내기', exact: true }).click();
  await expect.poll(() => sends.length).toBe(2);
  await expect(current()).toHaveAttribute('aria-label', /답 받음/);
  sendControl.gate.release();
  const cancel = current().getByRole('button', { name: '취소 요청', exact: true });
  await expect(cancel).toBeEnabled(); expect(sends[1].context_items).toEqual(sends[0].context_items);
  await expect(editor).toHaveValue('쓰던 글'); await expect(attachment).toBeVisible();
  expect((await current().boundingBox())!.height).toBe(geometry.height);
  await snapshot('1440-received');
  sendControl = { gate: gate(), fail: true }; await cancel.click(); await expect.poll(() => sends.length).toBe(3);
  await expect(current().getByText('취소 요청 보냄', { exact: true })).toBeVisible(); sendControl.gate.release();
  await expect(cancel).toBeEnabled();
  sendControl = { gate: gate(), fail: false }; await page.getByRole('button', { name: '다시 보내기', exact: true }).click(); await expect.poll(() => sends.length).toBe(4); sendControl.gate.release();
  await expect(current().getByText('취소 요청 보냄', { exact: true })).toBeVisible();
  await editor.focus(); await expect(editor).toBeFocused();
  expect(sends[3]).toMatchObject({ text: '블로그 저장소 브랜치 정리: 답을 취소합니다', context_items: [{ key: 'persistent_report_visible', content: { key: 'blog', title: '블로그 저장소 브랜치 정리' } }] });
  const reopened = { ...entries[1], title: '블로그 다시 확인', updated_at: 'latest' };
  publish([entries[0], reopened, entries[2]]);
  await expect(current().getByRole('heading')).toHaveText('블로그 다시 확인');
  await expect(current()).toHaveAttribute('aria-label', /답하실 것/);
  await expect(current().getByText('취소 요청 보냄', { exact: true })).toHaveCount(0);
  await editor.focus();
  publish([entries[1], entries[2]]);
  await expect(deck.locator('.pas-report-count')).toHaveText('1 / 2'); await expect(editor).toBeFocused();
  await track.focus(); await page.keyboard.press('ArrowRight');
  await expect(current().getByRole('heading')).toHaveText('다이제스트 세 편');
  // Portal remounts must restore the physical page as well as the selected key.
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(deck).toHaveAttribute('data-bubble', 'false');
  await expect.poll(() => track.evaluate(node => Math.abs(node.scrollLeft - node.clientWidth))).toBeLessThan(1);
  await expect(current().getByRole('heading')).toHaveText('다이제스트 세 편');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(deck).toHaveAttribute('data-bubble', 'true');
  await expect.poll(() => track.evaluate(node => Math.abs(node.scrollLeft - node.clientWidth))).toBeLessThan(1);
  const popup = page.waitForEvent('popup'); await current().getByRole('link', { name: 'Meta Muse Wonder' }).click();
  const opened = await popup; await expect(opened).toHaveURL('https://example.test/digest'); await opened.close();
  // The changed number set starts one prefetch, shared by an ordinary click.
  const thirdCardLink = current().getByRole('link', { name: '카드 338번 열기', exact: true });
  await expect.poll(() => cardLists).toBe(3);
  await expect(thirdCardLink).not.toHaveAttribute('href');
  await thirdCardLink.click(); await thirdCardLink.click();
  expect(cardLists).toBe(3);
  thirdCardList.release();
  await expect(workspace.getByTestId('card-detail')).toContainText('보고 카드 338');
  await workspace.getByRole('button', { name: '카드 닫기', exact: true }).click();
  await expect(workspace).toHaveCount(0);
  const missingCardLink = current().getByRole('link', { name: '카드 331번 열기', exact: true });
  await missingCardLink.click();
  await expect.poll(() => cardLists).toBe(4);
  await expect(missingCardLink).not.toHaveAttribute('href');
  await expect(workspace).toHaveCount(0);
  await expect(page.getByTestId('chat-input').locator('p[role=status]')).toHaveCount(0);
  const last = { ...entries[0], key: 'last', title: '마지막 보고', options: [] };
  publish([...entries, last]); await expect(deck.locator('.pas-report-count')).toHaveText('2 / 3');
  await page.setViewportSize({ width: 1180, height: 820 });
  await waitForReportLayout();
  await page.screenshot({ path: path.join(output, '1180-see.png') });
  await current().getByRole('button', { name: '봤다', exact: true }).focus();
  await current().getByRole('button', { name: '봤다', exact: true }).click();
  await expect(deck.getByTestId('report-sheet-digest')).toHaveCount(0);
  await expect(deck.locator('.pas-report-count')).toHaveText('2 / 2');
  await expect(current().getByRole('heading')).toHaveText('마지막 보고');
  await expect(current()).toBeFocused();
  await page.screenshot({ path: path.join(output, '1180-dismiss-pending.png') });
  firstDismiss.release();
  await expect(page.getByRole('status').filter({ hasText: '보고를 내리지 못했어.' })).toBeVisible();
  await expect(deck.getByTestId('report-sheet-digest')).toHaveCount(1);
  await expect(deck.locator('.pas-report-count')).toHaveText('3 / 3');
  await deck.getByRole('button', { name: '앞 장', exact: true }).click();
  await expect(current().getByRole('heading')).toHaveText('다이제스트 세 편');
  await page.screenshot({ path: path.join(output, '1180-dismiss-failed.png') });
  await current().getByRole('button', { name: '봤다', exact: true }).click();
  await expect(current().getByRole('heading')).toHaveText('마지막 보고');
  await expect(current()).toBeFocused();
  secondDismiss.release();
  await expect(page.getByRole('status').filter({ hasText: '보고를 내리지 못했어.' })).toHaveCount(0);
  await expect(page.getByTestId('chat-input').locator('p[role=status]')).toHaveText('');
  expect(deletes).toEqual(['digest', 'digest']);
  await current().focus(); publish([entries[1]]);
  await expect(deck.locator('.pas-report-nav')).toHaveCount(0);
  await page.screenshot({ path: path.join(output, '1180-one.png') });
  publish([]); await expect(deck).toHaveCount(0); await expect(editor).toBeFocused();
  await page.screenshot({ path: path.join(output, '1180-empty.png') });
  const measurements: Record<string, unknown> = {};
  const maximum = { ...reportReviewEntries[0], key: 'maximum', title: '소울스트림 첨부 보관과 채팅 미리보기 설계안', card_numbers: [245, 314, 270],
    context: '첨부를 R2에 보관하고 채팅에서 미리 보게 하자 하신 일입니다. 저장 경로와 만료 규칙, 미리보기 크기 제한까지 설계를 마쳤고, 머지된 변경은 조건을 붙여 배포할 수 있습니다. 남은 것은 옛 첨부를 옮길 순서입니다.',
    action: '셋 가운데 하나를 골라 주십시오. 지금 전부 옮기면 한 시간쯤 걸리고, 새 첨부부터 적용하면 곧바로 되며, 보류하시면 다음 주에 다시 여쭙겠습니다. 비교는 설계 문서에 적었습니다.',
    options: ['지금 전부 옮겨서 적용', '새 첨부부터 바로 적용', '다음 주까지 결정 보류'] };
  publish([reportReviewEntries[1], reportReviewEntries[2]]);
  await expect(current().getByRole('heading')).toHaveText(reportReviewEntries[1].title);
  for (const width of [1920, 1440, 1180, 900, 390]) {
    await page.setViewportSize({ width, height: width === 1920 ? 1080 : 900 });
    await expect(deck).toHaveAttribute('data-bubble', String(width >= 1180));
    await snapshot(`${width}-answer`);
    const box = (await deck.boundingBox())!;
    measurements[width] = box;
    if (width >= 1180) expect(box.width).toBe(width === 1920 ? 441 : width === 1440 ? 342 : 318);
    else expect(await deck.locator('.pas-report-tail').count()).toBe(0);
    if (width === 390) {
      const task = (await page.getByRole('button', { name: '작업 목록', exact: true }).boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(task.y + task.height + 8);
      expect(await deck.locator('.pas-report-nav button:visible').count()).toBe(0);
      await track.focus(); await page.keyboard.press('ArrowRight'); await expect(current().getByRole('heading')).toHaveText(reportReviewEntries[2].title);
      await track.focus(); await page.keyboard.press('ArrowLeft');
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await track.focus(); await page.keyboard.press('ArrowRight'); await expect(current().getByRole('heading')).toHaveText(reportReviewEntries[2].title);
  await snapshot('1440-three-card-chips');
  publish([maximum, reportReviewEntries[1]]); await track.focus(); await page.keyboard.press('ArrowLeft'); await expect(current().getByRole('heading')).toHaveText(maximum.title);
  await snapshot('1440-three-answer-buttons');
  await page.getByRole('button', { name: '라이트 모드로 전환', exact: true }).click(); await snapshot('1440-light');
  await page.getByRole('button', { name: '다크 모드로 전환', exact: true }).click();
  await page.setViewportSize({ width: 1180, height: 640 });
  await expect(deck).toHaveAttribute('data-bubble', 'true');
  const reading = current().locator('.pas-report-reading'); const footer = current().locator('.pas-report-footer');
  await expect.poll(() => reading.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  const footerBefore = (await footer.boundingBox())!;
  await snapshot('1180-overflow-top');
  await reading.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await expect(reading).toHaveAttribute('data-more', 'false');
  expect((await footer.boundingBox())!.y).toBe(footerBefore.y);
  await snapshot('1180-overflow-bottom');
  // Defer a PAS height update until the pointer interaction ends.
  await page.setViewportSize({ width: 1440, height: 900 });
  publish([reportReviewEntries[1]]); await expect(current().getByRole('heading')).toHaveText(reportReviewEntries[1].title); await waitForReportLayout();
  const heldHeight = (await deck.boundingBox())!.height;
  const point = (await current().getByRole('heading').boundingBox())!;
  await page.mouse.move(point.x + 4, point.y + 4); await page.mouse.down();
  publish([{ ...maximum, key: reportReviewEntries[1].key, updated_at: 'held' }]);
  await expect(current().getByRole('heading')).toHaveText(maximum.title);
  expect((await deck.boundingBox())!.height).toBe(heldHeight);
  await page.mouse.up(); await expect.poll(async () => (await deck.boundingBox())!.height).toBeGreaterThan(heldHeight);
  await page.setViewportSize({ width: 1180, height: 600 }); await expect(deck).toHaveAttribute('data-bubble', 'false');
  // A different composer send blocks answers, then leaves the existing notice on failure.
  publish([reportReviewEntries[1]]); await expect(current().getByRole('heading')).toHaveText(reportReviewEntries[1].title);
  sendControl = { gate: gate(), fail: true }; await editor.fill('다른 글'); await page.getByTestId('send-button').click();
  await expect.poll(() => sends.length).toBe(5);
  await expect(current().getByRole('button', { name: '응', exact: true })).toBeDisabled();
  sendControl.gate.release(); await expect(current().getByRole('button', { name: '응', exact: true })).toBeEnabled();
  await current().getByRole('button', { name: '응', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '보내지 못한 글이 대화에 남아 있어. 다시 보내거나 입력창으로 옮겨 줘.' })).toBeVisible();
  expect(sends.length).toBe(5);
  expect(fixture.errors).toEqual([]); expect(cardDetails.some(id => /^\d+$/.test(id))).toBe(false);
  writeFileSync(path.join(output, 'metrics.json'), JSON.stringify({ geometry, sends, deletes, measurements, cardLists, cardDetails, errors: fixture.errors }, null, 2));
  for (const update of [...updates, ...events]) update.gate.release();
});

test('PAS settings failure settles loading and shows later SSE reports above chat',async({page})=>{
  await page.setViewportSize({width:1440,height:900});
  const fixture=await installChatUiRoutes(page,{ui:false,count:3});
  const settings={default_model:{model_preset:null,reasoning_effort:null},fallback_model:null,show_generation_separator:true,show_character:true,show_jev_candidates:true,animate_character:false,show_turn_usage:true,turn_usage_mode:'collapsed'};
  const resource={session_id:chatUiSession,display_name:'설정 조회 실패 검수',node_id:'eiaserinnys',folder_id:'rb-alpha',agent_id:'roselin_codex',agent_name:'로젤린',persistent:true,settings,persistent_report:reportReviewEntries,runtime:{current_model:{model_preset:null,reasoning_effort:null,model:'codex'},pending:null}};
  const lookup=gate(),reportUpdate=gate(); let lookupRequests=0,streamRequests=0;
  await page.route('**/api/persistent-sessions**',async route=>{
    const pathname=new URL(route.request().url()).pathname;
    if(pathname==='/api/persistent-sessions')return route.fulfill({json:{sessions:[resource],total:1,create_defaults:{node_id:resource.node_id,preferred_agent_id:resource.agent_id,settings,initial_instruction:'',unavailable_reason:null}}});
    if(pathname.endsWith('/instructions'))return route.fulfill({json:{instructions:[]}});
    lookupRequests++; await lookup.promise; return route.fulfill({status:503,json:{detail:'설정 조회 실패'}});
  });
  await page.route('**/api/sessions/stream?*',async route=>{
    if(streamRequests++===0)return route.fulfill({contentType:'text/event-stream',body:'retry: 100\n\n'+sse('session_list',{sessions:[{agentSessionId:chatUiSession,status:'running',eventCount:3,nodeId:'eiaserinnys',agentId:'roselin_codex'}],total:1},1)});
    await reportUpdate.promise;
    return route.fulfill({contentType:'text/event-stream',body:'retry: 60000\n\n'+sse('session_updated',{agent_session_id:chatUiSession,persistent_report:[{...reportReviewEntries[0],title:'설정 실패 뒤의 보고',updated_at:'failed-settings'}]},2)});
  });
  await page.goto(`/persistent/${chatUiSession}`);
  await expect(page.getByRole('textbox',{name:'메시지',exact:true})).toBeVisible();
  await expect.poll(()=>lookupRequests).toBeGreaterThan(0);
  const deck=page.getByTestId('report-deck'); await expect(deck).toHaveCount(0);
  lookup.release(); await expect(deck).toBeVisible(); await expect(deck).toHaveAttribute('data-bubble','false');
  reportUpdate.release(); await expect(deck.getByRole('heading')).toHaveText('설정 실패 뒤의 보고');
  await expect(deck.locator('.pas-report-tail')).toHaveCount(0);
  await page.evaluate(()=>document.fonts.ready); await page.mouse.move(0,0);
  await page.screenshot({path:path.join(output,'1440-settings-failed-r4.png')});
  expect(fixture.errors).toEqual([]);
});
