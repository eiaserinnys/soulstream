const assert = require('node:assert/strict');

// Serialized by Playwright into the page; keep this function self-contained.
function loadedImageWithin(host) {
  const image = host?.tagName === 'IMG' ? host : host?.querySelector('img');
  if (!image?.complete || !(image.naturalWidth > 0)) return false;
  return { hostTag: host.tagName, imageTag: image.tagName,
    url: image.currentSrc || image.src, naturalWidth: image.naturalWidth };
}

function assertAssistantAlignment(name, galleryLeft, bubbleContentLeft, tolerance = 1) {
  assert.ok(Number.isFinite(galleryLeft) && Number.isFinite(bubbleContentLeft),
    `${name} assistant reference line missing`);
  assert.ok(Math.abs(galleryLeft - bubbleContentLeft) <= tolerance,
    `${name} output image gallery should align to assistant bubble content left edge: ${galleryLeft - bubbleContentLeft}px`);
}

module.exports = { loadedImageWithin, assertAssistantAlignment };
