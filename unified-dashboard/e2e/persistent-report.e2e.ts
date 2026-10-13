import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { installChatUiRoutes, chatUiSession } from './chat-ui-fixtures';
import { reportReviewEntries } from '../client/v3/persistent-report-review-data';
import { waitForStableLayout } from './layout-stability';
import { reviewCard } from '../client/v3/components-review-fixtures';

const output = path.resolve('../../../.local/artifacts/pas-report-card-link-r2c');
const sse = (type: string, payload: object, id: number) => `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
test('PAS HTTP/SSE report pager, reply/undo/failure/retry, latest board and focus', async ({ page }) => {
  mkdirSync(output, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  const fixture = await installChatUiRoutes(page, { ui: false, count: 3 });
  const cards = [270, 328].map((number, index) => ({ ...reviewCard,
    id: index === 0 ? '0ef7a7b5-588f-436b-839b-53131aba0a43' : '89a431e6-f40b-4164-91b8-9ca5f40b3454',
    number, folderId: 'rb-alpha', title: `보고 카드 ${number}`, assigneeKind: null, assigneeSessionId: null, assigneeAgentId: null }));
  let cardLists = 0;
  const firstCardList = gate();
  const cardDetails: string[] = [];
  await page.route(url => url.pathname === '/api/cards', async route => {
    if (new URL(route.request().url()).searchParams.get('includeCompleted') !== 'true') return route.fulfill({ json: { cards: [] } });
    cardLists++;
    if (cardLists === 1) await firstCardList.promise;
    return route.fulfill({ json: { cards: cardLists === 1 ? [cards[0]] : cards } });
  });
  await page.route(url => url.pathname.startsWith('/api/cards/'), route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.slice('/api/cards/'.length));
    cardDetails.push(id);
    const card = cards.find(card => card.id === id);
    // Production treats a number as an unknown ID; never conceal this regression.
    if (!card) return route.fulfill({ status: 404, json: { detail: { error: { code: 'CARD_NOT_FOUND', message: '카드가 없습니다' } } } });
    return route.fulfill({ json: { card, reports: [], questions: [], sessions: [], comments: [], notes: [] } });
  });
  await page.addInitScript(() => localStorage.setItem('soul-dashboard-theme', 'light'));
  let entries = reportReviewEntries;
  const settings = { default_model: { model_preset: null, reasoning_effort: null }, fallback_model: null, show_generation_separator: true, show_character: false, show_jev_candidates: true, animate_character: false, show_turn_usage: true, turn_usage_mode: 'collapsed' };
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
  const sends: Record<string, unknown>[] = [];
  await page.route('**/api/sessions/*/intervene', route => {
    sends.push(route.request().postDataJSON());
    return sends.length === 1 ? route.fulfill({ status: 503, json: { detail: '검수 전송 실패' } }) : route.fulfill({ json: { delivered: true } });
  });
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
  await page.screenshot({ path: path.join(output, '1440-default.png') });
  const workspace = page.getByTestId('v3-card-workspace');
  const firstCardLink = current().getByRole('link', { name: '카드 270번 열기', exact: true });
  await expect(firstCardLink).not.toHaveAttribute('href');
  await firstCardLink.click(); await firstCardLink.click();
  await expect.poll(() => cardLists).toBe(1);
  await expect(workspace).toHaveCount(0);
  firstCardList.release();
  await expect(workspace.getByTestId('card-detail')).toContainText('보고 카드 270');
  await expect(firstCardLink).toHaveAttribute('href', `/?card=${cards[0].id}`);
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
  await waitForStableLayout(deck, ['[data-current="true"]']);
  const secondCardLink = current().getByRole('link', { name: '카드 328번 열기', exact: true });
  await expect(secondCardLink).not.toHaveAttribute('href');
  await secondCardLink.focus(); await expect(secondCardLink).toBeFocused(); await page.keyboard.press('Enter');
  await expect(workspace.getByTestId('card-detail')).toContainText('보고 카드 328');
  expect(cardLists).toBe(2);
  await workspace.getByRole('button', { name: '카드 닫기', exact: true }).click();
  await expect(workspace).toHaveCount(0);
  await waitForStableLayout(deck, ['[data-current="true"]']);
  const geometry = await current().evaluate(node => ({ height: node.getBoundingClientRect().height, x: node.querySelector('h2')!.getBoundingClientRect().x }));
  await editor.fill('쓰던 글');
  await page.getByTestId('chat-input').locator('input[type=file]').setInputFiles({ name: '메모.pdf', mimeType: 'application/pdf', buffer: Buffer.from('첨부') });
  await expect(page.getByTestId('chat-input').getByTitle('메모.pdf')).toBeVisible();
  const mode = await page.getByTestId('send-button').getAttribute('data-button-variant');
  await current().getByRole('button', { name: '응', exact: true }).click();
  await expect(editor).toHaveValue('쓰던 글\n\n블로그 저장소 브랜치 정리: 응'); await expect(editor).toBeFocused();
  expect(await editor.evaluate(node => node.selectionEnd)).toBe((await editor.inputValue()).length);
  await page.getByRole('button', { name: '되돌리기', exact: true }).click(); await expect(editor).toHaveValue('쓰던 글');
  await current().getByRole('button', { name: '응', exact: true }).click();
  await expect(page.getByTestId('chat-input').getByTitle('메모.pdf')).toBeVisible();
  expect(await page.getByTestId('send-button').getAttribute('data-button-variant')).toBe(mode);
  await page.screenshot({ path: path.join(output, '1440-compose-attachment-undo.png') });
  // The appended draft example is visible context; only a whole exact reply binds.
  await editor.fill('');
  await current().getByRole('button', { name: '응', exact: true }).click();
  await page.getByTestId('send-button').click();
  await expect(page.getByRole('button', { name: '다시 보내기', exact: true })).toBeVisible();
  await expect(current().locator('.pas-report-kind')).toHaveText('답하실 것');
  expect(sends[0].context_items).toEqual([{ key: 'persistent_report_reply', content: { key: 'blog', option: '응' } }]);
  await page.getByRole('button', { name: '다시 보내기', exact: true }).click();
  await expect(current().locator('.pas-report-kind')).toHaveText('답 받음');
  expect(sends[1].context_items).toEqual(sends[0].context_items);
  expect((await current().boundingBox())!.height).toBe(geometry.height);
  await page.screenshot({ path: path.join(output, '1440-received.png') });
  const reopened = { ...entries[1], title: '블로그 다시 확인', updated_at: 'latest' };
  publish([entries[0], reopened, entries[2]]);
  await expect(current().getByRole('heading')).toHaveText('블로그 다시 확인');
  await expect(current().locator('.pas-report-kind')).toHaveText('답하실 것');
  await editor.focus();
  publish([entries[1], entries[2]]);
  await expect(deck.locator('.pas-report-count')).toHaveText('1 / 2'); await expect(editor).toBeFocused();
  await track.focus(); await page.keyboard.press('ArrowRight');
  await expect(current().getByRole('heading')).toHaveText('다이제스트 세 편');
  const popup = page.waitForEvent('popup'); await current().getByRole('link', { name: 'Meta Muse Wonder' }).click();
  const opened = await popup; await expect(opened).toHaveURL('https://example.test/digest'); await opened.close();
  const missingCardLink = current().getByRole('link', { name: '카드 338번 열기', exact: true });
  await missingCardLink.click();
  await expect.poll(() => cardLists).toBe(3);
  await expect(missingCardLink).not.toHaveAttribute('href');
  await expect(workspace).toHaveCount(0);
  await expect(page.getByTestId('chat-input').locator('p[role=status]')).toHaveCount(0);
  const last = { ...entries[0], key: 'last', title: '마지막 보고', options: [] };
  publish([...entries, last]); await expect(deck.locator('.pas-report-count')).toHaveText('2 / 3');
  await page.setViewportSize({ width: 1180, height: 820 });
  await waitForStableLayout(deck, ['[data-current="true"]']);
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
  const single = { ...reportReviewEntries[0], key: 'x-refs', title: 'X 그림 두 장을 레퍼런스에', card_numbers: [334],
    context: 'moodydarkroom의 X 글에서 그림 두 장을 수퍼포지션 시각 레퍼런스에 넣으라 하신 일입니다. 그 글에 사진이 넷이라 멈춰 있습니다.',
    action: '번호 둘만 주십시오. 1 얼굴에 다색 광선, 2 거울 앞, 3 등에 빛나는 나비, 4 주황 배경' };
  for (const width of [1440, 1180]) {
    await page.setViewportSize({ width, height: 900 });
    publish([reportReviewEntries[1], single]);
    await track.focus(); await page.keyboard.press('ArrowLeft');
    await editor.focus();
    await expect(deck.locator('.pas-report-count')).toHaveText('1 / 2');
    await waitForStableLayout(deck, ['.pas-report-sheet']);
    const normalHeight = (await deck.boundingBox())!.height;
    expect(normalHeight).toBe(236);
    // Compare the approved original nav offset in the same frame/content.
    const baselineStyle = await page.addStyleTag({ content: '.persistent-session-main > .pas-report { --pas-report-nav-right: var(--v3-space-4) !important; }' });
    const before = await deck.screenshot({ animations: 'disabled' });
    await baselineStyle.evaluate(node => node.remove());
    const after = await deck.screenshot({ animations: 'disabled', path: path.join(output, `${width}-normal-final.png`) });
    expect(after.equals(before)).toBe(true);
    publish([maximum, single]);
    await expect(current().getByRole('heading')).toHaveText(maximum.title);
    await waitForStableLayout(deck, ['.pas-report-sheet']);
    const maximumHeight = (await deck.boundingBox())!.height;
    expect(maximumHeight).toBe(258);
    await page.screenshot({ path: path.join(output, `${width}-maximum-final.png`) });
    publish([single]);
    await expect(deck.locator('.pas-report-nav')).toHaveCount(0);
    await waitForStableLayout(deck, ['.pas-report-sheet']);
    const singleHeight = (await deck.boundingBox())!.height;
    expect(singleHeight).toBe(170);
    await page.screenshot({ path: path.join(output, `${width}-single-final.png`) });
    measurements[width] = { normalHeight, maximumHeight, singleHeight, originalNavPixelsEqual: true };
  }
  publish(reportReviewEntries);
  await expect(deck.locator('.pas-report-count')).toHaveText('1 / 3');
  await expect(current().getByRole('heading')).toHaveText(reportReviewEntries[0].title);
  for (const width of [390, 600]) {
    await page.setViewportSize({ width, height: 900 });
    await waitForStableLayout(deck, ['.pas-report-nav']);
    const next = deck.getByRole('button', { name: '다음 장', exact: true });
    const task = page.getByRole('button', { name: '작업 목록', exact: true });
    const nextBox = (await next.boundingBox())!, taskBox = (await task.boundingBox())!;
    const hit = await next.evaluate(button => { const b = button.getBoundingClientRect(); return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest('button') === button; });
    expect(hit).toBe(true);
    measurements[width] = { next: nextBox, task: taskBox, centerHitsNext: hit };
    await page.screenshot({ path: path.join(output, `${width}-navigation-final.png`) });
    await page.mouse.click(nextBox.x + nextBox.width / 2, nextBox.y + nextBox.height / 2);
    await expect(current().getByRole('heading')).toHaveText(reportReviewEntries[1].title);
    await expect(page.locator('.persistent-session-tasks')).toHaveCount(0);
    await deck.getByRole('button', { name: '앞 장', exact: true }).click();
    await expect(current().getByRole('heading')).toHaveText(reportReviewEntries[0].title);
  }
  expect(fixture.errors).toEqual([]);
  expect(cardDetails.some(id => /^\d+$/.test(id))).toBe(false);
  writeFileSync(path.join(output, 'metrics.json'), JSON.stringify({ geometry, mode, sends, deletes, measurements, cardLists, cardDetails, errors: fixture.errors }, null, 2));
  for (const update of updates) update.gate.release();
});
