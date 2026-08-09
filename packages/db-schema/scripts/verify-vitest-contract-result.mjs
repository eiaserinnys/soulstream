import { readFile } from "node:fs/promises";

const [resultPath, expectedRaw] = process.argv.slice(2);
const expected = Number(expectedRaw);
if (!resultPath || !Number.isInteger(expected) || expected < 1) {
  throw new Error("usage: verify-vitest-contract-result.mjs <result.json> <expected-tests>");
}

const result = JSON.parse(await readFile(resultPath, "utf8"));
if (result.success !== true
  || result.numTotalTests !== expected
  || result.numPassedTests !== expected
  || result.numFailedTests !== 0
  || result.numPendingTests !== 0
  || result.numTodoTests !== 0) {
  throw new Error(
    `database release test collection mismatch: ${JSON.stringify({
      success: result.success,
      total: result.numTotalTests,
      passed: result.numPassedTests,
      failed: result.numFailedTests,
      skipped: result.numPendingTests,
      todo: result.numTodoTests,
      expected,
    })}`,
  );
}
process.stdout.write(`DATABASE_RELEASE_POSTGRES_TESTS=${expected}; SKIPPED=0\n`);
