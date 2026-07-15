import {
  HarnessAlreadyRunningError,
  listBrowserDescendants,
  runPlaywrightLifecycle,
} from "./playwright-lifecycle-harness.mjs";

const results = [];

await runPlaywrightLifecycle({
  lockName: "lifecycle-demo-normal",
  timeoutMs: 20_000,
}, async ({ browser }) => {
  const page = await browser.newPage();
  await page.setContent("<main>normal lifecycle demo</main>");
  results.push({ case: "normal", status: "passed" });
});
recordResiduals("normal");

try {
  await runPlaywrightLifecycle({
    lockName: "lifecycle-demo-failure",
    timeoutMs: 20_000,
  }, async ({ browser }) => {
    const page = await browser.newPage();
    await page.setContent("<main>failure lifecycle demo</main>");
    throw new Error("expected demo failure");
  });
  throw new Error("failure case unexpectedly succeeded");
} catch (error) {
  if (error.message !== "expected demo failure") throw error;
  results.push({ case: "failure", status: "cleanup-passed" });
}
recordResiduals("failure");

await runPlaywrightLifecycle({
  lockName: "lifecycle-demo-duplicate",
  timeoutMs: 20_000,
}, async () => {
  try {
    await runPlaywrightLifecycle({
      lockName: "lifecycle-demo-duplicate",
      timeoutMs: 20_000,
    }, async () => undefined);
    throw new Error("duplicate case unexpectedly launched");
  } catch (error) {
    if (!(error instanceof HarnessAlreadyRunningError)) throw error;
    results.push({ case: "duplicate", status: "blocked-before-launch" });
  }
});
recordResiduals("duplicate");

console.log(JSON.stringify({ ok: true, results }, null, 2));

function recordResiduals(caseName) {
  const residualPids = listBrowserDescendants().map(({ pid }) => pid);
  if (residualPids.length > 0) {
    throw new Error(`${caseName} left Chromium descendants: ${residualPids.join(", ")}`);
  }
  results.push({ case: caseName, residualProcesses: 0 });
}
