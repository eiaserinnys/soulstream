const assert = require('node:assert/strict');
const path = require('node:path');
const { fixturePage, swipe } = require('./persistent-fullscreen-capture.cjs');

async function metrics(locator) {
  return locator.evaluate(el => {
    const b = el.getBoundingClientRect(), c = getComputedStyle(el);
    return { x: b.x, y: b.y, width: b.width, height: b.height, background: c.backgroundColor,
      border: c.borderBottomColor, borderWidth: c.borderTopWidth, color: c.color,
      scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  });
}
const measure = (page, id) => metrics(page.getByTestId(id).first());
const center = b => b.y + b.height / 2;
async function circle(page, id) {
  return page.getByTestId(id).evaluate(root => {
    const el = [root, ...root.querySelectorAll('div')].find(el => {
      const c = getComputedStyle(el), b = el.getBoundingClientRect();
      return b.width === b.height && b.width > 0 && parseFloat(c.borderRadius) > 0 && parseFloat(c.borderTopWidth) > 0;
    });
    if (!el) throw new Error('Visible circle missing: ' + root.dataset.testid);
    return el.getBoundingClientRect().toJSON();
  });
}
async function shot(env, page, name) {
  await page.screenshot({ path: path.join(env.output, name + '.png') });
}

async function runPersistentFixCaptures(env) {
  for (const s of [
    { name: 'ipad-l-light', width: 1180, height: 820, theme: 'light', sheet: 460, detail: 318 },
    { name: 'ipad-p-dark', width: 820, height: 1180, theme: 'dark', sheet: 369, detail: 340 },
  ]) {
    const { context, page } = await fixturePage(env, s.name, s, `sample=screen&theme=${s.theme}&safeArea=fixture`);
    const pas = page.getByTestId('persistent-session-screen');
    await pas.getByTestId('persistent-session-character-seat').waitFor();
    const record = { name: s.name, body: await measure(page, 'persistent-session-character-seat'),
      line: await measure(page, 'persistent-session-baseline'), column: await measure(page, 'persistent-session-conversation') };
    const attach = await metrics(pas.getByTestId('chat-composer-attach-button'));
    const send = await metrics(pas.getByTestId('chat-composer-send-button'));
    const toggle = await measure(page, 'persistent-session-character-toggle');
    record.inputCenters = { attach: center(attach), send: center(send), toggle: center(toggle) };
    assert.ok(Math.abs(center(toggle) - center(attach)) <= 1 && Math.abs(center(toggle) - center(send)) <= 1, 'R5 input centers');
    record.surfaces = {};
    for (const id of ['session-story-panel', 'runtime-tasks-strip', 'runtime-schedules-strip']) {
      if (await pas.getByTestId(id).count()) record.surfaces[id] = await metrics(pas.getByTestId(id));
    }
    await shot(env, page, s.name + '-chat');
    // A5: no draft, attachment or input-height change before this first round trip.
    await page.getByTestId('persistent-session-tasks').click();
    await page.getByTestId('card-row-public-persistent-412-summary').click();
    await page.getByTestId('card-read-summary-open').waitFor();
    record.panel = await measure(page, 'persistent-session-card-panel');
    record.footer = await measure(page, 'card-read-summary-footer');
    assert.equal(record.panel.width, s.detail);
    assert.ok(record.panel.height < 800, 'R4 content height');
    if (s.width > s.height) assert.equal(record.panel.x - record.column.x - record.column.width, 24, 'R4 landscape gap');
    else assert.ok(record.panel.y + record.panel.height < record.line.y, 'R4 above line');
    assert.ok(Math.abs(record.footer.y + record.footer.height - (record.panel.y + record.panel.height - 21)) <= 2, 'footer follows content');
    await shot(env, page, s.name + '-summary');
    await page.getByTestId('persistent-summary-back').click();
    await page.getByTestId('card-row-public-persistent-412-summary').waitFor();
    record.summaryBackToList = true;
    await page.getByTestId('card-row-public-persistent-412-summary').click();
    await page.getByTestId('card-read-summary-open').click();
    await page.getByTestId('card-detail-frame').waitFor();
    record.sheet = await measure(page, 'persistent-tablet-card-sheet');
    assert.equal(record.sheet.width, s.sheet, 'A1 existing card sheet width');
    await shot(env, page, s.name + '-full-detail');
    await page.getByTestId('card-detail-frame').getByLabel('뒤로', { exact: true }).click();
    await page.getByTestId('card-read-summary-open').waitFor();
    record.returnImmediate = { body: await measure(page, 'persistent-session-character-seat'),
      line: await measure(page, 'persistent-session-baseline'), toggle: await measure(page, 'persistent-session-character-toggle') };
    for (const key of ['x', 'y', 'width', 'height']) {
      assert.equal(record.returnImmediate.body[key], record.body[key], 'A5 body ' + key);
      assert.equal(record.returnImmediate.line[key], record.line[key], 'A5 line ' + key);
    }
    await shot(env, page, s.name + '-return-immediate');
    await page.getByTestId('persistent-session-tasks').click();
    await swipe(page, 'left');
    assert.equal(await page.getByTestId('persistent-session-card-panel').count(), 0, 'A3 no iPad swipe');
    await page.getByTestId('persistent-session-character-toggle').click();
    await page.getByTestId('persistent-session-character-seat').waitFor({ state: 'hidden' });
    record.offToggle = await measure(page, 'persistent-session-character-toggle-icon');
    await shot(env, page, s.name + '-toggle-off');
    await page.getByTestId('persistent-session-character-toggle').click();
    await page.getByTestId('persistent-session-character-seat').waitFor();
    await page.getByTestId('persistent-session-home').click();
    await page.getByTestId('tablet-persistent-entry').waitFor();
    record.homeEntry = await circle(page, 'tablet-persistent-entry');
    record.homePeer = await metrics(page.getByLabel('보드 확대', { exact: true }));
    record.homeGap = record.homeEntry.x - (record.homePeer.x + record.homePeer.width);
    assert.equal(record.homeEntry.width, 48, 'R9 standard circle');
    assert.equal(record.homePeer.width, 48, 'R9 peer standard circle');
    assert.equal(record.homeGap, 8, 'R9 peer gap');
    assert.equal(center(record.homeEntry), center(record.homePeer), 'R9 vertical center');
    await shot(env, page, s.name + '-home-entry');
    env.result.viewports.push(record);
    await context.close();
  }
  // Longer public card exercises the maximum height and fixed footer while content scrolls.
  {
    const { context, page } = await fixturePage(env, 'ipad-capped', { width: 1180, height: 820 }, 'sample=screen&case=long&safeArea=fixture');
    await page.getByTestId('persistent-session-tasks').click();
    await page.getByTestId('card-row-public-persistent-412-summary').click();
    await page.getByTestId('card-read-summary-open').waitFor();
    const panel = await measure(page, 'persistent-session-card-panel');
    const scroll = await page.getByTestId('card-read-summary-scroll').evaluate(root => {
      const el = [root, ...root.querySelectorAll('div')].find(el => ['auto', 'scroll'].includes(getComputedStyle(el).overflowY));
      return { height: el.clientHeight, content: el.scrollHeight };
    });
    const before = await measure(page, 'card-read-summary-open');
    await page.getByTestId('card-read-summary-scroll').evaluate(root => {
      const el = [root, ...root.querySelectorAll('div')].find(el => ['auto', 'scroll'].includes(getComputedStyle(el).overflowY));
      el.scrollTop = el.scrollHeight;
    });
    const after = await measure(page, 'card-read-summary-open');
    assert.deepEqual(after, before, 'R4 capped footer remains fixed');
    assert.ok(scroll.content > scroll.height, 'R4 capped summary scrolls');
    env.result.viewports.push({ name: 'ipad-capped', panel, scroll, footer: after });
    await shot(env, page, 'ipad-capped-summary');
    await context.close();
  }
  for (const theme of ['light', 'dark']) {
    const name = 'iphone-' + theme;
    const { context, page } = await fixturePage(env, name, { width: 390, height: 844 }, `sample=screen&theme=${theme}&safeArea=fixture`);
    await page.getByTestId('persistent-session-screen').waitFor();
    const record = { name };
    record.ring = await measure(page, 'persistent-phone-tab-ring');
    record.portrait = await page.getByTestId('persistent-phone-tab-portrait').first().locator(':scope > div').first().boundingBox();
    assert.equal(record.ring.borderWidth, '2px');
    assert.ok(Math.abs(record.portrait.x + record.portrait.width / 2 - (record.ring.x + record.ring.width / 2)) <= 1, 'R6 centered portrait');
    record.headerCircle = await circle(page, 'persistent-session-tasks');
    assert.equal(record.headerCircle.x + record.headerCircle.width, 370, 'R8 right edge');
    await page.getByTestId('phone-tab-PersistentTab').click();
    const row = page.getByTestId('card-row-public-persistent-412-summary');
    await row.waitFor();
    record.row = await metrics(row);
    record.number = await measure(page, 'card-public-persistent-412-number');
    assert.equal(record.number.x, 20, 'R8 text edge');
    assert.equal(record.number.x - record.row.x, 8, 'R8 pressed bleed');
    record.panel = await measure(page, 'persistent-session-card-panel');
    record.header = await measure(page, 'persistent-session-header');
    record.paper = await measure(page, 'persistent-session-safe-area');
    assert.equal(record.panel.background, record.paper.background, 'R8 phone paper');
    const firstGroup = await page.getByTestId('persistent-task-group-running').boundingBox();
    record.groupGap = firstGroup.y - (record.header.y + record.header.height);
    assert.ok(record.groupGap >= 12, 'R8 first group spacing');
    await shot(env, page, name + '-list');
    await page.mouse.move(record.row.x + 30, record.row.y + 20); await page.mouse.down();
    await page.waitForTimeout(200);
    await shot(env, page, name + '-pressed'); await page.mouse.up();
    await page.getByTestId('card-read-summary-open').waitFor();
    await shot(env, page, name + '-summary');
    await page.getByTestId('persistent-summary-back').click();
    await row.waitFor();
    await row.click();
    await page.getByTestId('card-read-summary-open').click();
    await page.getByTestId('card-detail-frame').waitFor();
    await page.waitForTimeout(250);
    record.detailTabs = await page.getByTestId(/^phone-tab-/).evaluateAll(els => els.map(el => ({ id: el.dataset.testid, display: getComputedStyle(el).display, height: el.getBoundingClientRect().height })));
    assert.equal(await page.getByTestId('phone-tab-PersistentTab').isVisible(), false, 'R2 detail hides tabs');
    await shot(env, page, name + '-full-detail');
    await page.getByTestId('card-detail-frame').getByLabel('뒤로', { exact: true }).click();
    await page.getByTestId('card-read-summary-open').waitFor();
    assert.equal(await page.getByTestId('persistent-summary-back').isVisible(), true);
    await shot(env, page, name + '-return-summary');
    await page.getByTestId('persistent-session-home').click();
    await page.evaluate(() => {
      window.__entrySheets = 0;
      window.__entryObserver = new MutationObserver(() => { if (document.querySelector('[data-testid="persistent-entry-sheet"]')) window.__entrySheets++; });
      window.__entryObserver.observe(document.body, { subtree: true, childList: true });
    });
    await page.getByTestId('phone-tab-PersistentTab').click();
    await page.getByTestId('persistent-session-screen').waitFor();
    record.entrySheets = await page.evaluate(() => { window.__entryObserver.disconnect(); return window.__entrySheets; });
    assert.equal(record.entrySheets, 0, 'R7 no transient one-session sheet');
    env.result.viewports.push(record);
    await context.close();
  }
  {
    const { context, page } = await fixturePage(env, 'fallback', { width: 390, height: 844 }, 'sample=entry&state=entry-loading&safeArea=fixture');
    await page.getByTestId('persistent-phone-tab-fallback').first().waitFor();
    await shot(env, page, 'iphone-fallback');
    await page.getByTestId('phone-tab-PersistentTab').click();
    await page.getByTestId('persistent-entry-loading').first().waitFor();
    assert.equal(await page.getByTestId('persistent-entry-sheet').count(), 0);
    await shot(env, page, 'iphone-entry-loading');
    env.result.viewports.push({ name: 'fallback-loading', sheetCount: 0, icon: 'person-circle-outline' });
    await context.close();
  }
  {
    const { context, page } = await fixturePage(env, 'choose', { width: 390, height: 844 }, 'sample=entry&count=2&theme=dark&safeArea=fixture');
    await page.getByTestId('phone-tab-PersistentTab').click();
    await page.getByTestId('persistent-entry-review-pas-2').waitFor();
    await page.waitForTimeout(400);
    const close = await metrics(page.getByLabel('영구 세션 선택 닫기', { exact: true }));
    await shot(env, page, 'iphone-choose-close');
    await page.getByLabel('영구 세션 선택 닫기', { exact: true }).click();
    await page.getByTestId('persistent-entry-sheet').waitFor({ state: 'hidden' });
    env.result.viewports.push({ name: 'choose-close', close });
    await context.close();
  }
  env.result.interactions.push('R2–R10, A1/A3/A5 actual routes and immediate return; ordinary default separately compared');
}
async function runPressedCaptures(env) {
  for (const s of [{ name: 'phone', width: 390, height: 844 }, { name: 'ipad', width: 1180, height: 820 }]) {
    const { context, page } = await fixturePage(env, s.name, s, 'sample=screen&theme=dark&safeArea=fixture');
    await page.getByTestId('persistent-session-tasks').click();
    const row = page.getByTestId('card-row-public-persistent-412-summary');
    await row.waitFor();
    const box = await metrics(row);
    await page.mouse.move(box.x + box.width / 2, center(box));
    await page.mouse.down();
    await page.waitForTimeout(200);
    const pressed = await metrics(row);
    assert.notEqual(pressed.background, 'rgba(0, 0, 0, 0)');
    const number = await measure(page, 'card-public-persistent-412-number');
    const clipping = await row.evaluate(el => {
      const result = [];
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        const css = getComputedStyle(parent);
        if (css.overflowX !== 'visible') {
          const b = parent.getBoundingClientRect(); result.push({ overflow: css.overflowX, x: b.x, right: b.right });
        }
      }
      return result;
    });
    for (const clip of clipping) assert.ok(clip.x <= pressed.x && clip.right >= pressed.x + pressed.width, 'R8 pressed background is not clipped');
    env.result.viewports.push({ name: s.name, pressed, number, clipping });
    await shot(env, page, s.name + '-pressed');
    await page.mouse.up();
    await context.close();
  }
}
module.exports = { runPersistentFixCaptures, runPressedCaptures };
