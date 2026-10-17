const assert = require('node:assert/strict');

// Playwright serializes this function into the page.
function measureAttachmentColors() {
  const visible = element => element.getBoundingClientRect().width > 0;
  const bubble = [...document.querySelectorAll('[data-testid="user-message-bubble"]')]
    .find(element => visible(element) && element.querySelector('[data-testid="message-attachments-images"]'));
  function textStyle(element) {
    const style = getComputedStyle(element);
    let opacity = 1;
    for (let parent = element; parent; parent = parent.parentElement) opacity *= Number(getComputedStyle(parent).opacity);
    return { text: element.textContent, color: style.color, opacity };
  }
  function background(element) {
    for (let parent = element; parent; parent = parent.parentElement) {
      const value = getComputedStyle(parent).backgroundColor;
      if (value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)') return value;
    }
    return null;
  }
  const body = bubble.querySelector('[data-testid="user-message-text"]');
  const fileRows = [...document.querySelectorAll('[data-testid^="message-attachment-row-"]')]
    .filter(element => visible(element) && element.closest('[data-testid="user-message-bubble"]'));
  return {
    body: { ...textStyle(body), background: background(body) },
    captions: [...bubble.querySelectorAll('[data-testid$="-caption"]')].map(textStyle),
    statuses: [...bubble.querySelectorAll('[data-testid="pending-message-status"], [data-testid="pending-message-failure-reason"]')].map(textStyle),
    fileText: fileRows.flatMap(row => [...row.querySelectorAll('[dir="auto"]')]
      .filter(element => element.children.length === 0 && element.textContent.trim())
      .map(element => ({ ...textStyle(element), background: background(element) }))),
  };
}

function rgba(value) {
  if (value.startsWith('#')) return [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16)).concat(1);
  const values = value.match(/[\d.]+/g).map(Number);
  return values.length === 3 ? [...values, 1] : values;
}

function contrastRatio(foreground, background) {
  const luminance = color => rgba(color).slice(0, 3).map(value => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function assertAttachmentColors(colors) {
  assert.ok(colors.captions.length > 0, 'user attachment captions rendered');
  for (const text of [...colors.captions, ...colors.statuses]) {
    assert.equal(text.color, colors.body.color, 'direct bubble text matches message body');
    assert.equal(text.opacity, 1, 'direct bubble text is opaque');
  }
  assert.ok(colors.fileText.length > 0, 'standard file row text rendered');
  return {
    caption: contrastRatio(colors.body.color, colors.body.background),
    fileText: colors.fileText.map(text => {
      assert.equal(rgba(text.background)[3], 1, 'file row surface is opaque');
      assert.equal(text.opacity, 1, 'file row text is opaque');
      const ratio = contrastRatio(text.color, text.background);
      assert.ok(ratio >= 4.5, `${text.text} file row contrast ${ratio}`);
      return { ...text, ratio };
    }),
  };
}

module.exports = { measureAttachmentColors, contrastRatio, assertAttachmentColors };
