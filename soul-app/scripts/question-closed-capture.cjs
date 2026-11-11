const assert = require('node:assert/strict');
const path = require('node:path');

// 카드 질문 줄의 답함/철회 칩을 앱 검수 화면(PAS 대화 목록)에서 잰다.
// 운영 형태 길이의 제목과 질문 글로 열린 질문, 같은 구간 답함, 대화 너머 답함, 철회를 본다.
async function runQuestionClosedCaptures({ browser, base, prefix, output, result }) {
  for (const scenario of [
    { name: 'question-closed-1280', viewport: { width: 1280, height: 900 } },
    { name: 'question-closed-390', viewport: { width: 390, height: 844 } },
  ]) {
    const context = await browser.newContext({
      viewport: scenario.viewport,
      screen: scenario.viewport,
      deviceScaleFactor: 1,
      isMobile: scenario.viewport.width < 768,
      hasTouch: true,
      reducedMotion: 'reduce',
    });
    await context.addCookies([{ name: 'review', value: 'fixture', url: base }]);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => result.errors.push({ name: scenario.name, message: error.message }));
    await page.addInitScript(() => {
      localStorage.setItem('soul-app-settings', JSON.stringify({ state: { appearance: 'light' }, version: 0 }));
    });
    await page.route('**/*', async route => {
      if (new URL(route.request().url()).origin !== base) {
        result.errors.push({ name: scenario.name, message: 'External request: ' + route.request().url() });
        await route.abort();
        return;
      }
      await route.continue();
    });
    await page.goto(`${base}${prefix}index.html?section=chat&theme=light`);
    await page.getByTestId('review-persistent-chat-projection').waitFor();
    const column = page.getByTestId('review-persistent-column-default');
    await column.scrollIntoViewIfNeeded();
    const titles = [
      '#1208 카드 상태 규칙을 XState로 리뉴얼하고 생성 그림으로 구멍 검증',
      '#1217 크랙 17호 세자르 만들기: 소개 문구, 상황 그림, 대화 시험',
      '#1220 PAS 채팅창의 질문 줄: 답이나 철회 뒤 표시 바꾸기',
      '#1197 PAS 판 카드 질문 장 표시 정리',
    ];
    for (const title of titles) await column.getByText(title, { exact: true }).waitFor();
    // 칩은 아이콘 글리프와 같은 Text 안에 있어 exact 텍스트로 잡히지 않는다. 행 접근성 이름으로 찾고 첫 줄을 본다.
    for (const [number, chip] of [[1208, '답함'], [1217, '답함'], [1220, '질문'], [1197, '철회']]) {
      const row = column.getByRole('link', { name: new RegExp(`^#${number} `) });
      await row.waitFor();
      const firstLine = (await row.innerText()).split('\n')[0];
      assert.ok(firstLine.includes(chip), `${scenario.name}: #${number} 칩 ${JSON.stringify(firstLine)}`);
    }
    assert.ok(
      await column.getByText('카드 상태 규칙 리뉴얼을 이번 주에 머지할까요, 생성 그림 검증을 먼저 마칠까요?', { exact: true }).count(),
      `${scenario.name}: 질문 글`,
    );
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(output, `${scenario.name}-viewport.png`) });
    await column.screenshot({ path: path.join(output, `${scenario.name}-column.png`) });
    result.viewports.push({ ...scenario, chips: { answered: 2, withdrawn: 1, question: 2 } });
    result.interactions.push(`${scenario.name}: PAS 대화 목록에서 열린 질문·답함 두 줄·철회 한 줄 확인`);
    await context.close();
  }
}

module.exports = { runQuestionClosedCaptures };
