// Targeted state measurements using the preserved Selaphiel fixture server.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const [pw, scripts, bundle, output] = process.argv.slice(2).map(v => path.resolve(v));
const { chromium } = require(pw);
const { startServer, newPage } = require(path.join(scripts, 'serve.cjs'));
const { measure } = require(path.join(scripts, 'measure.cjs'));
const evidence = { cases: {}, requests: [], errors: [], passed: false };
(async () => {
  await fs.mkdir(output, { recursive: true });
  const { server, base } = await startServer(bundle, evidence.requests);
  const browser = await chromium.launch();
  try {
    for (const [size, viewport] of Object.entries({ tablet: { width: 1194, height: 834 }, phone: { width: 390, height: 844 } })) {
      for (const presentation of ['default', 'manuscript']) for (const theme of ['light', 'dark']) {
        for (const mode of ['server-error', 'denied', 'delay', 'fail']) {
          if (theme === 'dark' && ['delay', 'fail'].includes(mode)) continue;
          const name = `${size}-${theme}-${presentation}-${mode}`;
          const cookies = ['delay', 'fail'].includes(mode) ? { 'img-mode': mode, 'img-delay': 4000 } : { 'fixture-mode': mode };
          const { context, page } = await newPage(browser, base, { viewport, hasTouch: true }, evidence.errors, cookies);
          const query = new URLSearchParams({ section: 'chatUiRenderer', sample: 'attachments', safeArea: 'fixture', theme, presentation });
          await page.goto(`${base}/assets/ios-components/index.html?${query}`);
          const user = page.locator('[data-testid="user-message-bubble"]:visible').filter({ hasText: '검토 자료를 함께 보냅니다.' });
          await user.waitFor();
          await page.evaluate(() => document.fonts.ready);
          const shot = async suffix => {
            await user.scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(output, `${name}${suffix}.png`) });
            return page.evaluate(measure);
          };
          const result = evidence.cases[name] = {};
          if (mode === 'server-error' || mode === 'denied') {
            await user.getByTestId('message-attachment-read-status').waitFor();
            const retry = user.getByRole('button', { name: '첨부 다시 시도', exact: true });
            result.retryCount = await retry.count();
            assert.equal(result.retryCount, mode === 'server-error' ? 1 : 0);
            result.statuses = await page.evaluate(() => [...document.querySelectorAll('[data-testid="message-attachment-read-status"]')]
              .filter(e => e.getBoundingClientRect().width > 0).map(e => {
                const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, right: r.right, width: r.width, height: r.height }; };
                const button = e.querySelector('[role="button"]');
                const caption = e.querySelector('[dir="auto"]');
                const userBubble = e.closest('[data-testid="user-message-bubble"]');
                const owner = userBubble ?? e.closest('[data-testid="assistant-attachment-content"]');
                const ownerStyle = getComputedStyle(owner);
                const body = userBubble?.querySelector('[data-testid="user-message-text"]');
                const bs = button ? getComputedStyle(button) : null;
                const label = button?.querySelector('[dir="auto"]');
                const naturalWidth = label ? rect(label).width + parseFloat(bs.paddingLeft) + parseFloat(bs.paddingRight)
                  + parseFloat(bs.borderLeftWidth) + parseFloat(bs.borderRightWidth) : null;
                return { user: !!userBubble, status: rect(e), caption: rect(caption), button: button ? rect(button) : null,
                  body: body ? rect(body) : null, naturalWidth,
                  contentLeft: rect(owner).x + parseFloat(ownerStyle.paddingLeft),
                  contentRight: rect(owner).right - parseFloat(ownerStyle.paddingRight) };
              }));
            result.before = await shot('');
            if (mode === 'server-error') {
              await context.addCookies([{ name: 'fixture-mode', value: 'normal', url: base }]);
              await retry.click();
              await user.getByTestId('message-attachments-images').waitFor();
              await user.getByText('빈 첨부.txt', { exact: true }).waitFor();
              result.recovered = true;
              result.after = await shot('-retried');
            }
          } else {
            await user.getByTestId('message-attachments-images').waitFor();
            if (mode === 'delay') {
              await user.getByTestId('chat-image-loading').first().waitFor();
              result.before = await shot('');
              await user.getByTestId('chat-image-loading').first().waitFor({ state: 'detached' });
              await page.waitForFunction(() => !document.querySelector('[data-testid="chat-image-loading"]'));
              result.after = await shot('-loaded');
              const frames = data => data.users.flatMap(u => u.imgs.map(i => [i.w, i.h]));
              assert.deepEqual(frames(result.before), frames(result.after));
            } else {
              await user.getByText('불러오지 못함', { exact: true }).first().waitFor();
              await page.waitForFunction(() => !document.querySelector('[data-testid="chat-image-loading"]'));
              result.before = await shot('');
              result.words = await user.getByText('불러오지 못함', { exact: true }).first().evaluate(e => {
                const words = e.textContent.trim().split(/\s+/); const text = e.firstChild;
                let offset = 0;
                return words.map(word => {
                  const index = text.textContent.indexOf(word, offset); const range = document.createRange();
                  range.setStart(text, index); range.setEnd(text, index + word.length); offset = index + word.length;
                  return { word, lines: range.getClientRects().length, wordBreak: getComputedStyle(e).wordBreak };
                });
              });
              assert.ok(result.words.every(w => w.lines === 1 && w.wordBreak === 'keep-all'));
            }
          }
          console.log(name, 'verified');
          await context.close();
        }
      }
    }
    evidence.passed = true;
  } finally {
    await fs.writeFile(path.join(output, 'states.json'), JSON.stringify(evidence, null, 2));
    await browser.close(); server.close();
  }
  console.log('Attachment states:', Object.keys(evidence.cases).length, 'passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
