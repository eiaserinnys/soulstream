import type { Locator } from "@playwright/test";

/** Wait for three consecutive animation frames with the same target bounds.
 * Re-query each frame because Virtuoso can replace rows while settling.
 * The Playwright test timeout bounds this wait; there is no fixed sleep.
 */
export async function waitForStableLayout(root: Locator, selectors: string[]) {
  await root.evaluate(async (element, selectors) => {
    await document.fonts.ready;
    await new Promise<void>((resolve, reject) => {
      let previous = "", equalFrames = 0;
      const frame = () => {
        if (!element.isConnected) { reject(new Error("Layout owner was detached")); return; }
        const targets = selectors.map(selector => element.querySelector(selector));
        if (targets.some(target => !target)) { previous = ""; equalFrames = 0; requestAnimationFrame(frame); return; }
        const bounds = targets.map(target => {
          const r = target!.getBoundingClientRect();
          return [r.x, r.y, r.width, r.height];
        });
        const current = JSON.stringify(bounds);
        equalFrames = current === previous ? equalFrames + 1 : 0;
        previous = current;
        if (equalFrames >= 2) resolve();
        else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  }, selectors);
}
