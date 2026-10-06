(async function () {
  "use strict";

  const canvas = document.querySelector("#motion-canvas");
  const root = new URL("./", document.location.href);
  const manifestUrl = new URL("manifest.json", root);
  const expressionsUrl = new URL("expressions.json", root);
  const clothingUrl = new URL("clothing.json", root);
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let renderer;
  let frameTime = 0;
  let lastFrameTime = 0;
  let lastDrawTime = 0;
  let rafId;
  let running = false;
  let failed = false;
  let ready = false;
  let state = { shown: true, motionEnabled: true, active: false };

  function send(type) {
    window.parent.postMessage({ type: `sway-character:${type}` }, window.location.origin);
  }

  function shouldRun() {
    return !failed
      && state.shown
      && state.motionEnabled
      && state.active
      && !document.hidden
      && !reducedMotion.matches;
  }

  function pause() {
    if (rafId !== undefined) cancelAnimationFrame(rafId);
    rafId = undefined;
    running = false;
    lastFrameTime = 0;
  }

  function fail(error) {
    if (failed) return;
    failed = true;
    pause();
    canvas.hidden = true;
    if (error) console.error(error);
    send("error");
  }

  function loadImage(id, src, url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => resolve([id, image]);
      image.onerror = () => reject(new Error("Character asset unavailable"));
      image.src = new URL(src, url).href;
    });
  }

  function paint(now) {
    if (failed || !renderer) return;
    frameTime += lastFrameTime ? Math.min(0.05, (now - lastFrameTime) / 1000) : 0;
    lastFrameTime = now;
    if (now - lastDrawTime > 33) {
      try {
        renderer.render(core.frameAt(frameTime, controls));
        lastDrawTime = now;
        if (!ready) {
          ready = true;
          send("ready");
        }
      } catch (error) {
        fail(error);
        return;
      }
    }
    if (shouldRun()) rafId = requestAnimationFrame(paint);
    else pause();
  }

  function resume() {
    if (!shouldRun() || running || !renderer) return;
    running = true;
    lastFrameTime = 0;
    rafId = requestAnimationFrame(paint);
  }

  const controls = core.normalizeControls({
    talking: false,
    autoBlink: true,
    headMotion: true,
    autoYaw: false,
    yaw: 0,
    autoGaze: true,
    breathing: true,
    wind: 0.22,
    expression: "neutral",
    showMesh: false,
  });

  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    fail();
  });
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent
      || event.origin !== window.location.origin
      || !event.data
      || typeof event.data !== "object"
      || event.data.type !== "sway-character:state") return;
    state = {
      shown: Boolean(event.data.shown),
      motionEnabled: Boolean(event.data.motionEnabled),
      active: Boolean(event.data.active),
    };
    if (shouldRun()) resume();
    else pause();
  });
  document.addEventListener("visibilitychange", () => {
    if (shouldRun()) resume();
    else pause();
  });
  reducedMotion.addEventListener("change", () => {
    if (shouldRun()) resume();
    else pause();
  });

  try {
    const responses = await Promise.all([manifestUrl, expressionsUrl, clothingUrl].map((url) => fetch(url)));
    if (responses.some((response) => !response.ok)) throw new Error("Character manifest unavailable");
    const [manifest, expressions, clothing] = await Promise.all(responses.map((response) => response.json()));
    manifest.expressionSet = normalizeExpressionManifest(expressions);
    manifest.clothingSet = normalizeClothingManifest(clothing);
    manifest.partTree = createPartTree(manifest, manifest.clothingSet);
    const loaded = await Promise.all([
      ...manifest.leaves.map((asset) => loadImage(asset.id, asset.src, manifestUrl)),
      ...manifest.expressions.map((asset) => loadImage(asset.id, asset.src, manifestUrl)),
      ...manifest.expressionSet.flatMap((expression) => [expression.eyes, expression.mouth])
        .map((asset) => loadImage(asset.imageId, asset.src, expressionsUrl)),
      ...manifest.clothingSet.map((asset) => loadImage(asset.imageId, asset.src, clothingUrl)),
    ]);
    renderer = new globalThis.SeosoyoungWebGLRenderer.MotionRenderer(canvas, manifest, new Map(loaded));
    if (shouldRun()) resume();
  } catch (error) {
    fail(error);
  }
})();
