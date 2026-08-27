import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCleanupRemovedMutation,
  restoreCleanupRemovedMutation,
} from "./fault-h2-product-mutation.mjs";

const CLEANUP_BLOCK = `      if (runner && task.executionOwnership === undefined) {
        try {
          if (proof && runner.dispatcher.rollbackExecutionIdentity) {
            await runner.dispatcher.rollbackExecutionIdentity(proof);
          } else {
            await runner.dispatcher.close();
          }
        } finally {
          releaseTaskRunner(task, runner);
        }
      }`;

test("cleanup-removed mutation deletes the rollback/close edge and restores byte-for-byte", () => {
  const source = `before\n${CLEANUP_BLOCK}\nafter\n`;
  const mutated = applyCleanupRemovedMutation(source);
  assert.match(mutated, /releaseTaskRunner\(task, runner\);/);
  assert.doesNotMatch(mutated, /rollbackExecutionIdentity/);
  assert.doesNotMatch(mutated, /runner\.dispatcher\.close/);
  assert.equal(restoreCleanupRemovedMutation(mutated, source), source);
  assert.throws(() => applyCleanupRemovedMutation(`${source}${CLEANUP_BLOCK}`), /exactly once/);
});
