import test from "node:test";
import assert from "node:assert/strict";
import {
  assertRunnerStatePathCompatible,
  runnerSocketPathByteLength,
} from "../lib/paths.mjs";
import { isRepeatedReentry } from "../lib/reentry.mjs";

test("재진입 반복은 같은 이유와 키일 때만 반복이다", () => {
  assert.equal(isRepeatedReentry(null, "checkout", "abc"), false);
  assert.equal(isRepeatedReentry(undefined, "node", "1.2.3:sha"), false);
  assert.equal(isRepeatedReentry({ reason: "checkout", key: "abc" }, "checkout", "abc"), true);
  assert.equal(isRepeatedReentry({ reason: "checkout", key: "abc" }, "checkout", "def"), false);
  assert.equal(isRepeatedReentry({ reason: "node", key: "abc" }, "checkout", "abc"), false);
  assert.equal(isRepeatedReentry({ reason: "checkout", key: "abc" }, "node", "abc"), false);
});

test("러너 소켓 경로는 가장 긴 경로의 바이트 수로 미리 판정한다", () => {
  const short = "/state/r";
  const shortest = runnerSocketPathByteLength(short);
  assert.equal(shortest, Buffer.byteLength(`${short}/${"0".repeat(24)}/runner.sock`, "utf8"));

  // darwin 한계(103)만 넘고 linux 한계(107) 안쪽인 길이.
  const darwinEdge = `/${"a".repeat(67)}`; // 길이 68, 소켓 경로 105바이트
  assert.equal(runnerSocketPathByteLength(darwinEdge), 105);
  assert.doesNotThrow(() => assertRunnerStatePathCompatible(darwinEdge, "linux"));
  assert.throws(() => assertRunnerStatePathCompatible(darwinEdge, "darwin"), /103/);

  const tooLong = `/${"a".repeat(100)}`; // 소켓 경로 137바이트
  assert.throws(() => assertRunnerStatePathCompatible(tooLong, "linux"), /107/);
  assert.throws(() => assertRunnerStatePathCompatible(tooLong, "darwin"), /103/);

  // win32는 named pipe라 파일 경로 길이 제한을 보지 않는다.
  assert.doesNotThrow(() => assertRunnerStatePathCompatible(tooLong, "win32"));
});
