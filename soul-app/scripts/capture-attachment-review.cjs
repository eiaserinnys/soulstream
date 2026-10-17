// Reuses Selaphiel's preserved fixture server and measurements at the requested viewport sizes.
// Run under heavy_verify with APP_ROOT and NODE_ENV=development.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const [pw, reviewerScripts, bundle, output, baselinePath] = process.argv.slice(2).map(v => path.resolve(v));
const baseline = require(baselinePath).result;
const { chromium } = require(pw);
const { startServer, newPage } = require(path.join(reviewerScripts, 'serve.cjs'));
const { measure } = require(path.join(reviewerScripts, 'measure.cjs'));
const sizes = { tablet: { width: 1194, height: 834 }, phone: { width: 390, height: 844 } };
const evidence = { cases: {}, errors: [], requests: [], passed: false };
async function open(browser, base, viewport, theme, presentation, cookies = {}, sample = 'selmod') {
  const result = await newPage(browser, base, { viewport, hasTouch: true }, evidence.errors, cookies);
  const query = new URLSearchParams({ section: 'chatUiRenderer', sample, safeArea: 'fixture', theme, presentation });
  await result.page.goto(`${base}/assets/ios-components/index.html?${query}`);
  await result.page.getByTestId('chat-composer-attach-button').first().waitFor();
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
    if (name.includes('phone') && user.gallery) {
      assert.ok(Math.abs(user.gallery.x - user.bubble.x - user.pad.l) <= 1, `${name} gallery fills bubble content`);
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
  return { imageWidths: widths, galleryWidths: three.map(u => u.gallery.w), gap,
    assistantLeft: assistant.contentLeft, outputLeft: out.gallery.x };
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  const { server, base } = await startServer(bundle, evidence.requests);
  const browser = await chromium.launch();
  try {
    for (const [size, viewport] of Object.entries(sizes)) for (const theme of ['light', 'dark']) for (const presentation of ['default', 'manuscript']) {
      const name = `${size}-${theme}-${presentation}`;
      const { context, page } = await open(browser, base, viewport, theme, presentation);
      await ready(page);
      const data = await snap(page, name);
      evidence.cases[name] = { data };
      evidence.cases[name].checks = assertLayout(name, data);
      await context.close();
    }
    evidence.passed = true;
  } finally {
    await fs.writeFile(path.join(output, 'review-evidence.json'), JSON.stringify(evidence, null, 2));
    await browser.close(); server.close();
  }
  console.log(`Attachment review: ${Object.keys(evidence.cases).length} cases passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
