// Run against the dashboard Vite server: node card1695.cjs <playwright-path> <base-url> <output-dir>
const path = require('node:path');
const fs = require('node:fs/promises');
const { chromium } = require(path.resolve(process.argv[2]));
const base = process.argv[3];
const output = path.resolve(process.argv[4]);
(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  for (const width of [1440, 360]) for (const scene of ['folder', 'session']) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await page.goto(`${base}/scripts/visual-check/card1695.html?scene=${scene}`, { waitUntil: 'networkidle' });
    if (scene === 'folder') {
      await page.getByPlaceholder('폴더 이름').fill('검수 폴더');
      await page.getByRole('button', { name: '만들기' }).click();
    }
    await page.locator('[role="alert"] summary').click();
    await page.locator('[role="alert"] details[open] pre').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(output, `web-${scene}-${width}.png`) });
    console.log(scene, width, await page.locator('[role="alert"] pre').innerText());
    await page.close();
  }
  await browser.close();
})().catch(error => { console.error(error); process.exitCode = 1; });
