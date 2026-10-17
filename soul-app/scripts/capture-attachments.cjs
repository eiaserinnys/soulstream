// Run under heavy_verify. This captures the RN web component review only.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { statSync } = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const { loadedImageWithin, assertAssistantAlignment } = require('./attachment-capture-checks.cjs');
const { measureAttachmentColors, assertAttachmentColors } = require('./attachment-capture-colors.cjs');

const [playwrightPath, fixtureUrlInput, outputPath, browserPath] = process.argv.slice(2);
if (!playwrightPath || !fixtureUrlInput || !outputPath) {
  throw new Error('Playwright module, loopback fixture URL, and output directory are required.');
}
const fixtureUrl = new URL(fixtureUrlInput);
assert.equal(fixtureUrl.protocol, 'http:');
assert.ok(['127.0.0.1', 'localhost'].includes(fixtureUrl.hostname));
assert.equal(fixtureUrl.port, '0', 'fixture URL must request an ephemeral loopback port');

const { chromium } = require(path.resolve(playwrightPath));
const appRoot = path.resolve(__dirname, '..');
const output = path.resolve(outputPath);
const webRoot = path.resolve(__dirname, '../../unified-dashboard/dist/assets/ios-components');
const assetPrefix = '/assets/ios-components/';
const sessionId = 'public-chat-ui-flow';
const sessionReadContext = { type: 'session', id: sessionId };
const imageOne = descriptor('review-chat-image-one', '검토 자료.png', 'image/png', statSync(path.join(appRoot, 'assets/icon.png')).size, 1);
const imageTwo = descriptor('review-chat-image-two', '마지막 이미지.png', 'image/png', statSync(path.join(appRoot, 'assets/icon-symbol.png')).size, 2);
const emptyText = descriptor('review-chat-empty-text', '빈 첨부.txt', 'text/plain', 0);
const outputImage = descriptor('review-agent-output-image', '응답 이미지.png', 'image/png', imageOne.byte_size, 1);
const eventItems = {
  101: [asset(imageOne), asset(imageTwo), asset(emptyText)],
  103: [asset(outputImage)],
  105: [{ kind: 'unavailable', attachment_id: emptyText.attachment_id, name: null,
    availability: 'unavailable', read_context: sessionReadContext }],
};
const evidence = {
  passed: false,
  browserScope: 'RN web component review with local public fixture; no iOS or device claim',
  fixtureChecks: {},
  captures: [],
  requests: [],
  externalRequests: [],
  pageErrors: [],
  warnings: [],
};

function descriptor(attachmentId, name, mimeType, byteSize, imageIndex) {
  return {
    attachment_id: attachmentId,
    name,
    mime_type: mimeType,
    byte_size: byteSize,
    checksum_sha256: null,
    width: imageIndex ? 1024 : null,
    height: imageIndex ? 1024 : null,
    preview_kind: mimeType.startsWith('image/') ? 'image' : 'text',
    preview_mime_type: mimeType.startsWith('image/') ? mimeType : 'text/plain',
  };
}

function asset(value) {
  return { kind: 'asset', descriptor: value, read_context: sessionReadContext, legacy_sources: [] };
}

function cookieValue(req, name) {
  const item = (req.headers.cookie ?? '').split(';').map(value => value.trim())
    .find(value => value.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : null;
}

function modeFor(req) { return cookieValue(req, 'fixture-mode') ?? 'normal'; }
function fixtureAuthenticated(req) {
  return cookieValue(req, 'review') === 'fixture' || /^Bearer\s+\S+/.test(req.headers.authorization ?? '');
}

function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}

function statusForMode(mode) {
  if (mode === 'unauthorized') return 401;
  if (mode === 'denied') return 403;
  if (mode === 'server-error') return 503;
  return null;
}

function streamBytes(res, req, id, url) {
  const files = {
    'review-chat-image-one': ['icon.png', 'image/png', imageOne.name],
    'review-chat-image-two': ['icon-symbol.png', 'image/png', imageTwo.name],
    'review-agent-output-image': ['icon.png', 'image/png', outputImage.name],
  };
  const row = files[id];
  const body = id === 'review-chat-empty-text' ? Buffer.alloc(0)
    : id === 'review-chat-range-text' ? Buffer.from('Range preview fixture\nSecond line\n', 'utf8')
      : row ? null : undefined;
  if (body === undefined) { json(res, 404, { detail: '첨부를 찾을 수 없습니다.' }); return; }
  const read = body === null ? fs.readFile(path.join(appRoot, 'assets', row[0])) : Promise.resolve(body);
  void read.then(bytes => {
    const modeStatus = statusForMode(modeFor(req));
    if (modeStatus) { json(res, modeStatus, { detail: 'fixture read rejected' }); return; }
    const contentType = row?.[1] ?? 'text/plain; charset=utf-8';
    const range = req.headers.range;
    const headers = { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
    if (url.searchParams.get('download') === 'true') {
      const filename = row?.[2] ?? (id === 'review-chat-empty-text' ? emptyText.name : '범위.txt');
      headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
    }
    if (range && bytes.length > 0) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match || Number(match[1]) !== 0) { res.writeHead(416); res.end(); return; }
      const requestedEnd = match[2] ? Number(match[2]) : bytes.length - 1;
      const end = Math.min(requestedEnd, bytes.length - 1);
      const slice = bytes.subarray(0, end + 1);
      res.writeHead(206, { ...headers, 'Content-Length': slice.length,
        'Content-Range': `bytes 0-${end}/${bytes.length}` });
      res.end(slice);
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': bytes.length });
    res.end(bytes);
  }).catch(() => json(res, 404, { detail: '첨부를 찾을 수 없습니다.' }));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, fixtureUrlInput);
  const mode = modeFor(req);
  if (url.pathname.startsWith('/api/')) {
    evidence.requests.push({ method: req.method, path: url.pathname, url: url.pathname + url.search, mode,
      authorized: Boolean(req.headers.authorization), fixtureCookie: cookieValue(req, 'review') === 'fixture' });
  }

  if (url.pathname === '/api/auth/status' && req.method === 'GET') {
    json(res, 200, { authenticated: true });
    return;
  }

  const eventMatch = /^\/api\/sessions\/([^/]+)\/events\/(\d+)\/attachments$/.exec(url.pathname);
  if (eventMatch && req.method === 'GET') {
    const status = statusForMode(mode);
    if (status) { json(res, status, { detail: 'fixture attachment read rejected' }); return; }
    const eventId = Number(eventMatch[2]);
    const items = eventItems[eventId];
    if (!items) { json(res, 404, { detail: '이벤트 첨부를 찾을 수 없습니다.' }); return; }
    json(res, 200, { event_id: eventId, items });
    return;
  }

  const contentMatch = /^\/api\/attachments\/([^/]+)\/content$/.exec(url.pathname);
  if (contentMatch && (req.method === 'GET' || req.method === 'HEAD')) {
    streamBytes(res, req, decodeURIComponent(contentMatch[1]), url);
    return;
  }

  const metadataMatch = /^\/api\/attachments\/([^/]+)$/.exec(url.pathname);
  if (metadataMatch && req.method === 'GET') {
    const status = statusForMode(mode);
    if (status) { json(res, status, { detail: 'fixture attachment read rejected' }); return; }
    const id = decodeURIComponent(metadataMatch[1]);
    const value = [imageOne, imageTwo, emptyText, outputImage].find(item => item.attachment_id === id);
    if (!value || mode === 'missing') { json(res, 404, { detail: '첨부를 찾을 수 없습니다.' }); return; }
    json(res, 200, { descriptor: value, upload_status: 'committed' });
    return;
  }

  if (url.pathname === '/api/attachments/files' && (req.method === 'HEAD' || req.method === 'GET')) {
    const status = statusForMode(mode);
    if (status) { res.writeHead(status); res.end(); return; }
    const file = url.searchParams.get('path')?.toLowerCase().includes('icon-symbol') ? 'icon-symbol.png' : 'icon.png';
    try {
      const bytes = await fs.readFile(path.join(appRoot, 'assets', file));
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': bytes.length,
        'Content-Disposition': `inline; filename="${file}"`, 'Cache-Control': 'no-store' });
      if (req.method === 'HEAD') res.end(); else res.end(bytes);
    } catch { res.writeHead(404); res.end(); }
    return;
  }

  if (!url.pathname.startsWith(assetPrefix)) { res.writeHead(404); res.end(); return; }
  const relative = decodeURIComponent(url.pathname.slice(assetPrefix.length));
  const file = path.resolve(webRoot, relative || 'index.html');
  if (file !== webRoot && !file.startsWith(webRoot + path.sep)) { res.writeHead(404); res.end(); return; }
  const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
    '.png': 'image/png', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2' };
  try {
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await fs.readFile(file));
  } catch { res.writeHead(404); res.end(); }
});

async function verifyFixtureContracts(base) {
  const auth = { Authorization: 'Bearer public-review-fixture', Cookie: 'review=fixture' };
  const projectionResponse = await fetch(`${base}/api/sessions/${sessionId}/events/101/attachments`, { headers: auth });
  assert.equal(projectionResponse.status, 200);
  const projection = await projectionResponse.json();
  assert.equal(projection.event_id, 101);
  assert.deepEqual(projection.items.map(item => item.kind), ['asset', 'asset', 'asset']);
  assert.ok(projection.items.every(item => item.read_context.type === 'session' && item.read_context.id === sessionId));
  assert.deepEqual(projection.items.map(item => item.descriptor.attachment_id), [
    imageOne.attachment_id, imageTwo.attachment_id, emptyText.attachment_id,
  ]);

  const normalMetadata = await fetch(`${base}/api/attachments/${emptyText.attachment_id}?context_type=session&context_id=${sessionId}`, { headers: auth });
  assert.equal(normalMetadata.status, 200);
  assert.equal((await normalMetadata.json()).descriptor.attachment_id, emptyText.attachment_id);
  const missingMetadata = await fetch(`${base}/api/attachments/${emptyText.attachment_id}?context_type=session&context_id=${sessionId}`, {
    headers: { ...auth, Cookie: 'review=fixture; fixture-mode=missing' },
  });
  assert.equal(missingMetadata.status, 404);

  const statusChecks = {};
  for (const [mode, expected] of [['unauthorized', 401], ['denied', 403], ['server-error', 503]]) {
    const response = await fetch(`${base}/api/sessions/${sessionId}/events/101/attachments`, {
      headers: { ...auth, Cookie: `review=fixture; fixture-mode=${mode}` },
    });
    statusChecks[mode] = response.status;
    assert.equal(response.status, expected);
  }

  const ranged = await fetch(`${base}/api/attachments/review-chat-range-text/content?context_type=session&context_id=${sessionId}`, {
    headers: { ...auth, Range: 'bytes=0-8' },
  });
  assert.equal(ranged.status, 206);
  assert.match(ranged.headers.get('content-range'), /^bytes 0-8\//);
  assert.equal((await ranged.text()).length, 9);
  const empty = await fetch(`${base}/api/attachments/${emptyText.attachment_id}/content?context_type=session&context_id=${sessionId}`, { headers: auth });
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get('content-length'), '0');
  assert.equal(await empty.arrayBuffer().then(bytes => bytes.byteLength), 0);

  evidence.fixtureChecks = {
    p6bHistoryProjection: 'event_id + ordered asset items + session read_context',
    c10Metadata: { normal: normalMetadata.status, missing: missingMetadata.status },
    authStatuses: statusChecks,
    range: { status: ranged.status, contentRange: ranged.headers.get('content-range') },
    emptyFile: { status: empty.status, contentLength: empty.headers.get('content-length') },
  };
}

async function waitForChat(page) {
  await page.getByTestId('review-chat-ui').waitFor();
  await page.locator('[data-testid="message-attachments"]').first().waitFor();
  await page.locator('[data-testid="chat-composer-attach-button"]:visible').first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="message-attachments"]').length >= 3);
  await page.evaluate(() => document.fonts.ready);
}

async function measureAndAssertAlignment(page, name) {
  const geometry = await page.evaluate(() => {
    const rect = element => {
      const value = element.getBoundingClientRect();
      return { x: value.x, right: value.right, width: value.width, y: value.y, height: value.height };
    };
    const edges = element => {
      const box = rect(element);
      const style = getComputedStyle(element);
      const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
      const paddingRight = Number.parseFloat(style.paddingRight) || 0;
      return { ...box, contentLeft: box.x + paddingLeft, contentRight: box.right - paddingRight,
        paddingLeft, paddingRight };
    };
    const visible = element => element.getBoundingClientRect().width > 0;
    const userBubble = [...document.querySelectorAll('[data-testid="user-message-bubble"]')]
      .find(element => visible(element) && element.querySelector('[data-testid="message-attachments-images"]'));
    const userGallery = userBubble?.querySelector('[data-testid="message-attachments-images"]');
    const outputGallery = [...document.querySelectorAll('[data-testid="message-attachments-images"]')]
      .find(element => visible(element) && !element.closest('[data-testid="user-message-bubble"]'));
    const userFileRows = userBubble?.querySelector('[data-testid="message-attachments-file-rows"]');
    const outputFileRows = outputGallery?.parentElement?.querySelector('[data-testid="message-attachments-file-rows"]');
    const outputColumn = outputGallery?.parentElement;
    const userContentLine = userBubble ? edges(userBubble) : null;
    const assistantBubble = [...document.querySelectorAll('[data-testid="assistant-message-bubble"]')].find(visible);
    const assistantContentLine = assistantBubble ? edges(assistantBubble) : null;
    const alignment = userContentLine && assistantContentLine && userGallery && userFileRows && outputGallery
      ? {
          tolerancePx: 1,
          userRightLine: userContentLine.contentRight,
          userGalleryRightDeltaPx: rect(userGallery).right - userContentLine.contentRight,
          userFileRowsRightDeltaPx: rect(userFileRows).right - userContentLine.contentRight,
          userGalleryToFileRowsRightDeltaPx: rect(userGallery).right - rect(userFileRows).right,
          assistantLeftLine: assistantContentLine.contentLeft,
          assistantGalleryLeftDeltaPx: rect(outputGallery).x - assistantContentLine.contentLeft,
          assistantFileRowsLeftDeltaPx: outputFileRows ? rect(outputFileRows).x - assistantContentLine.contentLeft : null,
        }
      : null;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      userGallery: userGallery ? rect(userGallery) : null,
      outputGallery: outputGallery ? rect(outputGallery) : null,
      userFileRows: userFileRows ? rect(userFileRows) : null,
      outputFileRows: outputFileRows ? rect(outputFileRows) : null,
      userBubble: userBubble ? rect(userBubble) : null,
      userContentLine,
      assistantAttachmentColumn: outputColumn ? rect(outputColumn) : null,
      assistantContentLine,
      alignment,
    };
  });
  const tolerance = geometry.alignment?.tolerancePx ?? 1;
  assert.equal(geometry.documentWidth > geometry.viewport.width, false, `${name} horizontal overflow`);
  assert.ok(geometry.userGallery, `${name} user attachment gallery not rendered`);
  assert.ok(geometry.outputGallery, `${name} assistant output gallery not rendered`);
  assert.ok(geometry.userFileRows, `${name} user TXT row not rendered`);
  assert.ok(geometry.alignment, `${name} alignment reference lines not measured`);
  assert.ok(Math.abs(geometry.alignment.userGalleryRightDeltaPx) <= tolerance,
    `${name} user image gallery should align to bubble content right edge: ${geometry.alignment.userGalleryRightDeltaPx}px`);
  assert.ok(Math.abs(geometry.alignment.userFileRowsRightDeltaPx) <= tolerance,
    `${name} user TXT row should align to bubble content right edge: ${geometry.alignment.userFileRowsRightDeltaPx}px`);
  assert.ok(Math.abs(geometry.alignment.userGalleryToFileRowsRightDeltaPx) <= tolerance,
    `${name} user image gallery and TXT row should share a right edge: ${geometry.alignment.userGalleryToFileRowsRightDeltaPx}px`);
  assertAssistantAlignment(name, geometry.outputGallery.x, geometry.assistantContentLine.contentLeft, tolerance);
  if (geometry.outputFileRows) {
    assert.ok(Math.abs(geometry.alignment.assistantFileRowsLeftDeltaPx) <= tolerance,
      `${name} output file rows should align to assistant content left edge: ${geometry.alignment.assistantFileRowsLeftDeltaPx}px`);
  }
  return geometry;
}

async function captureConversation(browser, base, { name, width, height, presentation = 'default', mode = 'normal', theme = 'light' }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, hasTouch: true });
  await context.addCookies([
    { name: 'review', value: 'fixture', url: base },
    { name: 'fixture-mode', value: mode, url: base },
  ]);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => evidence.pageErrors.push({ name, message: error.message }));
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') {
      evidence.warnings.push({ name, type: message.type(), message: message.text() });
    }
  });
  await page.route('**/*', async route => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin !== base) {
      evidence.externalRequests.push({ name, origin: requestUrl.origin, path: requestUrl.pathname });
      await route.abort();
      return;
    }
    await route.continue();
  });

  const query = new URLSearchParams({ section: 'chatUiRenderer', sample: mode === 'missing' ? 'attachments-missing' : 'attachments', safeArea: 'fixture' });
  query.set('theme', theme);
  if (presentation === 'manuscript') query.set('presentation', 'manuscript');
  await page.goto(`${base}${assetPrefix}index.html?${query}`);
  await waitForChat(page);
  await page.locator('[data-testid="user-message-bubble"]:visible')
    .filter({ has: page.locator('[data-testid="message-attachments-images"]') }).first().scrollIntoViewIfNeeded();
  const geometry = await measureAndAssertAlignment(page, name);
  const colors = await page.evaluate(measureAttachmentColors);
  const contrast = assertAttachmentColors(colors);
  if (mode === 'missing') {
    await page.getByText('사용할 수 없음', { exact: true }).scrollIntoViewIfNeeded();
  }
  const screenshot = path.join(output, `${name}.png`);
  await page.screenshot({ path: screenshot });
  evidence.captures.push({ name, screenshot, geometry, colors, contrast, presentation, mode, theme,
    safeAreaFixture: width >= 768 ? { top: 24, bottom: 20 } : { top: 47, bottom: 34 } });

  if (name === 'normal-phone') {
    const attachButton = page.locator('[data-testid="chat-composer-row"] [data-testid="chat-composer-attach-button"]').first();
    evidence.interactions = {
      attachButtonHitTest: await attachButton.evaluate(element => {
        const rect = element.getBoundingClientRect();
        let hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        const stack = [];
        while (hit && stack.length < 6) {
          const style = getComputedStyle(hit);
          stack.push({ tag: hit.tagName, testId: hit.getAttribute('data-testid'), role: hit.getAttribute('role'),
            ariaLabel: hit.getAttribute('aria-label'), className: typeof hit.className === 'string' ? hit.className : '',
            pointerEvents: style.pointerEvents, position: style.position, zIndex: style.zIndex });
          hit = hit.parentElement;
        }
        return { button: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, stack };
      }),
    };
    const buttonBox = await attachButton.boundingBox();
    assert.ok(buttonBox, 'attachment button has a visible hitbox');
    assert.equal(evidence.interactions.attachButtonHitTest.stack[0]?.testId, 'chat-composer-attach-button',
      'attachment button must be the topmost element at its center');
    await page.mouse.click(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2);
    await page.getByTestId('chat-attachment-preview-0').waitFor();
    const pendingScreenshot = path.join(output, 'normal-phone-pending-chip.png');
    await page.screenshot({ path: pendingScreenshot });

    const userMessage = page.locator('[data-testid="user-message-bubble"]')
      .filter({ has: page.getByTestId('message-attachments-images') }).first();
    await userMessage.getByTestId('message-attachments-images-image-0').click();
    const viewer = page.getByTestId('chat-image-viewer-viewport');
    await viewer.waitFor();
    const imageHost = await page.getByTestId('chat-image-viewer-image').elementHandle();
    const loadedImage = await page.waitForFunction(loadedImageWithin, imageHost);
    evidence.viewerImage = await loadedImage.jsonValue();
    const viewerScreenshot = part => page.screenshot({ path: path.join(output, `normal-phone-viewer-${part}.png`) });
    await viewerScreenshot('first');
    await page.getByTestId('chat-image-viewer-next').click();
    await page.getByTestId('chat-image-viewer-index').getByText('2 / 3', { exact: true }).waitFor();
    await page.getByTestId('chat-image-viewer-content').getByText(imageTwo.name, { exact: true }).waitFor();
    await viewerScreenshot('last-image');
    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('chat-image-viewer-save-original').click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), imageTwo.name);
    assert.deepEqual(await fs.readFile(await download.path()), await fs.readFile(path.join(appRoot, 'assets/icon-symbol.png')));
    await page.getByTestId('chat-image-viewer-next').click();
    await page.getByTestId('chat-image-viewer-index').getByText('3 / 3', { exact: true }).waitFor();
    await page.getByTestId('chat-image-viewer-content').getByText('빈 파일', { exact: true }).waitFor();
    await viewerScreenshot('last-file');
    await page.getByTestId('chat-image-viewer-previous').click();
    await page.getByTestId('chat-image-viewer-index').getByText('2 / 3', { exact: true }).waitFor();
    await page.getByTestId('chat-image-viewer-close').click();
    await viewer.waitFor({ state: 'hidden' });
    await userMessage.getByTestId('message-attachments-images-image-1').click();
    await viewer.waitFor();
    await page.getByTestId('chat-image-viewer-index').getByText('2 / 3', { exact: true }).waitFor();
    await viewerScreenshot('reopened');
    await page.getByTestId('chat-image-viewer-close').click();
    await viewer.waitFor({ state: 'hidden' });
    evidence.interactions = {
      pendingChip: true,
      pages: ['1 / 3', '2 / 3', '3 / 3'],
      lastImageSave: download.suggestedFilename(),
      closeAndReopen: true,
    };
    evidence.captures.push({ name: 'normal-phone-pending-chip', screenshot: pendingScreenshot });
  }

  await context.close();
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.access(path.join(webRoot, 'index.html'));
  server.listen(0, fixtureUrl.hostname);
  await once(server, 'listening');
  const address = server.address();
  const base = `http://${fixtureUrl.hostname}:${address.port}`;
  let browser;
  try {
    await verifyFixtureContracts(base);
    browser = await chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}) });
    await captureConversation(browser, base, { name: 'normal-phone', width: 390, height: 844 });
    await captureConversation(browser, base, { name: 'normal-tablet', width: 1194, height: 834 });
    await captureConversation(browser, base, { name: 'normal-phone-dark', width: 390, height: 844, theme: 'dark' });
    await captureConversation(browser, base, { name: 'normal-tablet-dark', width: 1194, height: 834, theme: 'dark' });
    await captureConversation(browser, base, { name: 'pas-phone', width: 390, height: 844, presentation: 'manuscript' });
    await captureConversation(browser, base, { name: 'pas-tablet', width: 1194, height: 834, presentation: 'manuscript' });
    await captureConversation(browser, base, { name: 'pas-phone-dark', width: 390, height: 844, presentation: 'manuscript', theme: 'dark' });
    await captureConversation(browser, base, { name: 'pas-tablet-dark', width: 1194, height: 834, presentation: 'manuscript', theme: 'dark' });
    await captureConversation(browser, base, { name: 'missing-phone', width: 390, height: 844, mode: 'missing' });
    assert.deepEqual(evidence.externalRequests, []);
    assert.deepEqual(evidence.pageErrors, []);
    assert.ok(evidence.requests.every(request => request.path === '/api/auth/status'
      || request.authorized || request.fixtureCookie), 'attachment REST and content requests use the local fixture auth');
    evidence.passed = true;
  } catch (error) {
    evidence.failure = error.message;
    throw error;
  } finally {
    await fs.writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
  console.log(JSON.stringify(evidence, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
