// Reuses Selaphiel's preserved fixture server and measurements at the requested viewport sizes.
// Run under heavy_verify with APP_ROOT and NODE_ENV=development.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const [pw, reviewerScripts, bundle, output, baselinePath, mainBundle] = process.argv.slice(2).map(v => path.resolve(v));
const baseline = require(baselinePath).result;
const { chromium } = require(pw);
const { startServer, newPage } = require(path.join(reviewerScripts, 'serve.cjs'));
const { measure } = require(path.join(reviewerScripts, 'measure.cjs'));
const sizes = { tablet: { width: 1194, height: 834 }, phone: { width: 390, height: 844 } };
const evidence = { cases: {}, errors: [], requests: [], passed: false };
async function open(browser, base, viewport, theme, presentation, sample = 'attachment-layout') {
  const result = await newPage(browser, base, { viewport, hasTouch: true }, evidence.errors);
  const query = new URLSearchParams({ section: 'chatUiRenderer', sample, safeArea: 'fixture', theme, presentation });
  await result.page.goto(`${base}/assets/ios-components/index.html?${query}`);
  await result.page.locator('[data-testid="chat-composer-attach-button"]:visible').first().waitFor();
  await result.page.evaluate(() => document.fonts.ready);
  return result;
}
async function ready(page) {
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="message-attachments-images"]').length >= 4
    && !document.querySelector('[data-testid="chat-image-loading"]'));
}
async function snap(page, name) {
  await page.screenshot({ path: path.join(output, `${name}.png`) });
  return page.evaluate(measure);
}
function assertLayout(name, data) {
  const three = data.users.filter(u => u.text && u.imgs.length === 2);
  assert.equal(three.length, 3, `${name} has all three text lengths`);
  const widths = three.map(u => u.imgs[0].w);
  assert.ok(Math.max(...widths) - Math.min(...widths) <= 1, `${name} image widths ${widths}`);
  for (const user of data.users) {
    if (user.text && user.ma) assert.ok(user.ma.y >= user.text.b, `${name} attachments follow body`);
    for (const row of user.fileRows) for (const text of row.texts) assert.equal(text.trunc, false, `${name} truncated ${text.t}`);
    if (!name.endsWith('manuscript') && user.gallery) {
      assert.ok(Math.abs(user.gallery.x - user.bubble.x - user.pad.l) <= 1, `${name} gallery starts at body content`);
      assert.equal(user.captions[0].align, 'left');
    }
    if (user.text && user.gallery && user.rows) {
      assert.ok(Math.abs((user.gallery.y - user.text.b) - (user.rows.y - user.gallery.b)) <= 1,
        `${name} body and attachment gaps match`);
    }
  }
  const assistant = data.assistants[0]; const out = data.outputs[0];
  assert.ok(assistant && out, `${name} output and response rendered`);
  assert.ok(Math.abs(out.gallery.x - assistant.contentLeft) <= 1, `${name} output starts at assistant content`);
  const gap = +(out.gallery.y - assistant.bubble.b).toFixed(1);
  const previous = baseline[`head-${name.replace('tablet', 'wide').replace('phone', 'narrow')}-attachments`];
  const expectedGap = name.endsWith('manuscript')
    ? previous.outputs[0].gallery.y - previous.assistants[0].bubble.b : 12;
  assert.ok(Math.abs(gap - expectedGap) <= 1, `${name} response/output gap ${gap}, expected ${expectedGap}`);
  const long = data.users.filter(u => u.allTexts.some(t => t.t.startsWith('이 긴 문장')));
  const attached = long.find(u => u.imgs.length > 0);
  const textOnly = long.find(u => u.imgs.length === 0);
  if (name.endsWith('manuscript')) {
    assert.ok(attached && textOnly, 'same long text with and without attachments');
    assert.ok(Math.abs(attached.text.w - textOnly.text.w) <= 1, 'PAS text width stays unchanged');
    assert.ok(Math.abs(attached.text.h - textOnly.text.h) <= 1, 'PAS line wrapping stays unchanged');
  }
  return { imageWidths: widths, galleryWidths: three.map(u => u.gallery.w), gap,
    bodyGaps: data.users.filter(u => u.text && u.gallery).map(u => +(u.gallery.y - u.text.b).toFixed(1)),
    fileGaps: data.users.filter(u => u.rows && u.gallery).map(u => +(u.rows.y - u.gallery.b).toFixed(1)),
    userStartDeltas: data.users.filter(u => u.gallery).map(u => +(name.endsWith('manuscript')
      ? u.gallery.r - u.bubble.r + u.pad.r : u.gallery.x - u.bubble.x - u.pad.l).toFixed(1)),
    longText: { attached: attached.text, textOnly: textOnly.text },
    assistantLeft: assistant.contentLeft, outputLeft: out.gallery.x };
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  const { server, base } = await startServer(bundle, evidence.requests);
  const main = await startServer(mainBundle, []);
  const browser = await chromium.launch();
  try {
    for (const [size, viewport] of Object.entries(sizes)) for (const theme of ['light', 'dark']) for (const presentation of ['default', 'manuscript']) {
      const name = `${size}-${theme}-${presentation}`;
      const { context, page } = await open(browser, base, viewport, theme, presentation);
      await ready(page);
      const data = await snap(page, name);
      evidence.cases[name] = { data };
      evidence.cases[name].checks = assertLayout(name, data);
      await page.locator('[data-testid="user-message-bubble"]:visible').filter({ hasText: '짧게' }).scrollIntoViewIfNeeded();
      await snap(page, `${name}-intervention`);
      await context.close();
      if (presentation === 'manuscript') {
        const reference = await open(browser, main.base, viewport, theme, presentation, 'selmod');
        await reference.page.getByText('이 긴 문장은 사용자 말풍선이 넓어질 때 첨부 묶음의 크기가 어떻게 달라지는지 보기 위한 표본 문장입니다.', { exact: true }).first().waitFor();
        const mainData = await snap(reference.page, `${name}-main`);
        const mainText = mainData.users.find(u => u.allTexts.some(t => t.t.startsWith('이 긴 문장'))).text;
        const current = evidence.cases[name].checks.longText.attached;
        assert.ok(Math.abs(current.w - mainText.w) <= 1 && Math.abs(current.h - mainText.h) <= 1, `${name} matches main text width and wrapping`);
        evidence.cases[name].checks.mainText = mainText;
        await reference.context.close();
      }
    }
    evidence.passed = true;
  } finally {
    await fs.writeFile(path.join(output, 'review-evidence.json'), JSON.stringify(evidence, null, 2));
    await browser.close(); server.close(); main.server.close();
  }
  console.log(`Attachment review: ${Object.keys(evidence.cases).length} cases passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
