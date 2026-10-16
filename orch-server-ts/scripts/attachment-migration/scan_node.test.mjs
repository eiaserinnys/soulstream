import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, open, rename, symlink, truncate, utimes, writeFile, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { FILE_OBSERVATION_STATUS, INVENTORY_ERROR_CODES } from "./inventory_contract.ts";
import { hashOpenedFile, isPathWithin, scanNodeSources } from "./scan_node.mjs";

const cutoff = "2027-01-01T00:00:00.000Z";
const sourceRef = {
  source_kind: "message",
  source_table: "events",
  source_pk: "event-1",
  source_pointer: "/attachments/0",
};

async function withRoots(run) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "attachment-scan-"));
  const allowed = path.join(temp, "allowed");
  const incoming = path.join(allowed, "incoming");
  await mkdir(incoming, { recursive: true });
  try {
    await run({ temp, allowed, incoming });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function collect(options) {
  const records = [];
  for await (const record of scanNodeSources(options)) records.push(record);
  return records;
}

async function collectCensus(options) {
  const scanner = scanNodeSources(options);
  const records = [];
  while (true) {
    const { value, done } = await scanner.next();
    if (done) return { records, census: value };
    records.push(value);
  }
}

test("keeps census incomplete when an incoming directory cannot be listed", async () => {
  await withRoots(async ({ allowed, incoming }) => {
    const blocked = path.join(incoming, "blocked");
    await mkdir(blocked);
    await writeFile(path.join(blocked, "present.png"), "present");
    await chmod(blocked, 0o000);
    try {
      const { records, census } = await collectCensus({ nodeId: "node-a", incomingRoot: incoming, explicitSources: [], allowedRoots: [allowed], cutoff });
      assert.equal(records[0].status, FILE_OBSERVATION_STATUS.path_denied);
      assert.equal(records[0].incoming_relative_path, undefined);
      assert.deepEqual(census, { incoming_census_complete: false });
    } finally {
      await chmod(blocked, 0o700);
    }
  });
});

test("keeps census incomplete when the incoming root does not exist", async () => {
  await withRoots(async ({ allowed, incoming }) => {
    const { census } = await collectCensus({ nodeId: "node-a", incomingRoot: path.join(incoming, "missing"), explicitSources: [], allowedRoots: [allowed], cutoff });
    assert.deepEqual(census, { incoming_census_complete: false });
  });
});

test("keeps census incomplete when an incoming file changes during hashing", async () => {
  await withRoots(async ({ allowed, incoming }) => {
    const file = path.join(incoming, "changing.txt");
    await writeFile(file, "before");
    const signal = {
      aborted: false,
      addEventListener() { writeFileSync(file, "changed while hashing"); },
      removeEventListener() {},
    };
    const { records, census } = await collectCensus({ nodeId: "node-a", incomingRoot: incoming, explicitSources: [], allowedRoots: [allowed], cutoff, signal });
    assert.equal(records[0].status, FILE_OBSERVATION_STATUS.unstable);
    assert.deepEqual(census, { incoming_census_complete: false });
  });
});

test("keeps census incomplete for file access denial and a broken incoming symlink", async () => {
  await withRoots(async ({ allowed, incoming }) => {
    const file = path.join(incoming, "denied.txt");
    await writeFile(file, "denied");
    await chmod(file, 0o000);
    await symlink(path.join(incoming, "missing"), path.join(incoming, "broken-link"));
    try {
      const { records, census } = await collectCensus({ nodeId: "node-a", incomingRoot: incoming, explicitSources: [], allowedRoots: [allowed], cutoff });
      assert.deepEqual(new Set(records.map((record) => record.status)), new Set([FILE_OBSERVATION_STATUS.path_denied, FILE_OBSERVATION_STATUS.source_absent]));
      assert.deepEqual(census, { incoming_census_complete: false });
    } finally {
      await chmod(file, 0o600);
    }
  });
});

test("keeps census incomplete after a hash interruption and an abort of empty census", async () => {
  await withRoots(async ({ allowed, incoming }) => {
    const controller = new AbortController();
    controller.abort();
    const options = { nodeId: "node-a", incomingRoot: incoming, explicitSources: [], allowedRoots: [allowed], cutoff, signal: controller.signal };
    const empty = await collectCensus(options);
    assert.deepEqual(empty.census, { incoming_census_complete: false });
    await writeFile(path.join(incoming, "file.txt"), "present");
    const interrupted = await collectCensus(options);
    assert.equal(interrupted.records[0].status, FILE_OBSERVATION_STATUS.hash_interrupted);
    assert.deepEqual(interrupted.census, { incoming_census_complete: false });
  });
});

test("does not publish completed census when the consumer stops traversal early", async () => {
  await withRoots(async ({ allowed, incoming }) => {
    await writeFile(path.join(incoming, "a.txt"), "a");
    await writeFile(path.join(incoming, "b.txt"), "b");
    const scanner = scanNodeSources({ nodeId: "node-a", incomingRoot: incoming, explicitSources: [], allowedRoots: [allowed], cutoff });
    assert.equal((await scanner.next()).done, false);
    assert.deepEqual(await scanner.return(), { value: undefined, done: true });
  });
});

test("publishes completed census only at EOF, including an empty root", async () => {
  await withRoots(async ({ allowed, incoming }) => {
    const options = { nodeId: "node-a", incomingRoot: incoming, explicitSources: [], allowedRoots: [allowed], cutoff };
    assert.deepEqual((await collectCensus(options)).census, { incoming_census_complete: true, incoming_root: incoming });
    await writeFile(path.join(incoming, "file.txt"), "present");
    assert.deepEqual((await collectCensus(options)).census, { incoming_census_complete: true, incoming_root: incoming });
  });
});

test("censuses small, empty, and Korean-named files with streaming hashes", async () => {
  await withRoots(async ({ allowed, incoming }) => {
    await writeFile(path.join(incoming, "small.txt"), "attachment");
    await writeFile(path.join(incoming, "빈 파일.bin"), Buffer.alloc(0));
    const records = await collect({ nodeId: "node-a", incomingRoot: incoming, explicitSources: [], allowedRoots: [allowed], cutoff });
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((record) => record.status), [FILE_OBSERVATION_STATUS.observed, FILE_OBSERVATION_STATUS.observed]);
    assert.deepEqual(records.map((record) => record.size_bytes), [10, 0]);
    assert.ok(records.every((record) => /^[0-9a-f]{64}$/.test(record.sha256)));
    assert.ok(records.some((record) => record.incoming_relative_path === "빈 파일.bin"));
    assert.ok(records.every((record) => record.bytes_read === record.size_bytes));
  });
});

test("streams a file larger than 100 MiB without buffering the file", async () => {
  await withRoots(async ({ allowed, incoming }) => {
    const file = path.join(incoming, "large.bin");
    const size = 101 * 1024 * 1024;
    await writeFile(file, Buffer.alloc(0));
    await truncate(file, size);
    const [record] = await collect({ nodeId: "node-a", incomingRoot: incoming, explicitSources: [], allowedRoots: [allowed], cutoff });
    assert.equal(record.status, FILE_OBSERVATION_STATUS.observed);
    assert.equal(record.size_bytes, size);
    assert.equal(record.bytes_read, size);
    assert.match(record.sha256, /^[0-9a-f]{64}$/);
  });
});

test("unions explicit sources outside incoming with source lineage", async () => {
  await withRoots(async ({ allowed, incoming }) => {
    const legacy = path.join(allowed, "legacy", "report.txt");
    await mkdir(path.dirname(legacy), { recursive: true });
    await writeFile(legacy, "from report");
    const [record] = await collect({
      nodeId: "node-a",
      incomingRoot: incoming,
      explicitSources: [{ node_id: "node-a", path: "legacy/report.txt", physical_path: legacy, source_ref: sourceRef }],
      allowedRoots: [allowed],
      cutoff,
    });
    assert.equal(record.status, FILE_OBSERVATION_STATUS.observed);
    assert.deepEqual(record.known_source_paths, ["legacy/report.txt"]);
    assert.deepEqual(record.source_refs, [sourceRef]);
    assert.equal(record.incoming_relative_path, undefined);
  });
});

test("hashes files newer than cutoff but excludes them as candidates", async () => {
  await withRoots(async ({ allowed, incoming }) => {
    const file = path.join(incoming, "new.txt");
    await writeFile(file, "new");
    const afterCutoff = new Date("2027-01-02T00:00:00.000Z");
    await utimes(file, afterCutoff, afterCutoff);
    const [record] = await collect({ nodeId: "node-a", incomingRoot: incoming, explicitSources: [], allowedRoots: [allowed], cutoff });
    assert.equal(record.status, FILE_OBSERVATION_STATUS.after_cutoff);
    assert.equal(record.after_cutoff, true);
    assert.equal(record.eligible_candidate, false);
    assert.match(record.sha256, /^[0-9a-f]{64}$/);
  });
});

test("records a missing explicit source as incomplete coverage", async () => {
  await withRoots(async ({ allowed, incoming }) => {
    const absent = path.join(allowed, "gone.txt");
    const [record] = await collect({
      nodeId: "node-a",
      incomingRoot: incoming,
      explicitSources: [{ node_id: "node-a", path: "gone.txt", physical_path: absent, source_ref: sourceRef }],
      allowedRoots: [allowed],
      cutoff,
    });
    assert.equal(record.status, FILE_OBSERVATION_STATUS.source_absent);
    assert.equal(record.error_code, INVENTORY_ERROR_CODES.source_absent);
    assert.equal(record.coverage_complete, false);
  });
});

test("does not hash an explicit path that resolves to a directory", async () => {
  await withRoots(async ({ allowed, incoming }) => {
    const directory = path.join(allowed, "folder");
    await mkdir(directory);
    const [record] = await collect({
      nodeId: "node-a",
      incomingRoot: incoming,
      explicitSources: [{ node_id: "node-a", path: "folder", physical_path: directory, source_ref: sourceRef }],
      allowedRoots: [allowed],
      cutoff,
    });
    assert.equal(record.status, FILE_OBSERVATION_STATUS.not_regular);
    assert.equal(record.error_code, INVENTORY_ERROR_CODES.not_regular);
    assert.equal(record.coverage_complete, false);
  });
});

test("follows an in-root symlink and denies a symlink escaping allowed roots", async () => {
  await withRoots(async ({ temp, allowed, incoming }) => {
    const internal = path.join(allowed, "internal.txt");
    const externalRoot = path.join(temp, "external");
    await mkdir(externalRoot);
    const external = path.join(externalRoot, "secret.txt");
    await writeFile(internal, "safe");
    await writeFile(external, "outside");
    await symlink(internal, path.join(incoming, "inside-link"));
    await symlink(external, path.join(incoming, "outside-link"));
    const records = await collect({ nodeId: "node-a", incomingRoot: incoming, explicitSources: [], allowedRoots: [allowed], cutoff });
    assert.equal(records.length, 2);
    assert.ok(records.some((record) => record.status === FILE_OBSERVATION_STATUS.observed && record.sha256));
    const denied = records.find((record) => record.status === FILE_OBSERVATION_STATUS.path_denied);
    assert.equal(denied.error_code, INVENTORY_ERROR_CODES.path_denied);
    assert.equal(denied.coverage_complete, false);
  });
});

test("an unconfirmed incoming root leaves node coverage incomplete", async () => {
  await withRoots(async ({ allowed, temp }) => {
    const records = await collect({ nodeId: "node-a", incomingRoot: path.join(temp, "missing"), explicitSources: [], allowedRoots: [allowed], cutoff });
    assert.equal(records.length, 1);
    assert.equal(records[0].status, FILE_OBSERVATION_STATUS.root_unconfirmed);
    assert.equal(records[0].error_code, INVENTORY_ERROR_CODES.root_unconfirmed);
    assert.equal(records[0].coverage_complete, false);
  });
});

test("an empty incoming directory has complete zero-file coverage", async () => {
  await withRoots(async ({ allowed, incoming }) => {
    const records = await collect({ nodeId: "node-a", incomingRoot: incoming, explicitSources: [], allowedRoots: [allowed], cutoff });
    assert.deepEqual(records, []);
  });
});

test("reports a file changed while hashing", async () => {
  const stats = [
    { isFile: () => true, size: 3, mtimeMs: 1, dev: 1, ino: 1 },
    { isFile: () => true, size: 4, mtimeMs: 2, dev: 1, ino: 1 },
  ];
  const handle = { stat: async () => stats.shift(), createReadStream: () => Readable.from([Buffer.from("abc")]) };
  const result = await hashOpenedFile(handle, new Date(cutoff), undefined);
  assert.equal(result.status, FILE_OBSERVATION_STATUS.unstable);
  assert.equal(result.errorCode, INVENTORY_ERROR_CODES.file_changed);
});

test("reports pathname replacement while the original file is open", async () => {
  await withRoots(async ({ allowed }) => {
    const filePath = path.join(allowed, "source.txt");
    const displacedPath = path.join(allowed, "old-source.txt");
    await writeFile(filePath, "old");
    const handle = await open(filePath, "r");
    try {
      await rename(filePath, displacedPath);
      await writeFile(filePath, "new");
      const result = await hashOpenedFile(handle, new Date(cutoff), undefined, filePath);
      assert.equal(result.status, FILE_OBSERVATION_STATUS.unstable);
      assert.equal(result.errorCode, INVENTORY_ERROR_CODES.file_changed);
    } finally {
      await handle.close();
    }
  });
});

test("reports a hash interrupted after reading begins", async () => {
  const controller = new AbortController();
  const stream = new Readable({
    read() {
      this.push(Buffer.alloc(1024));
      controller.abort();
    },
  });
  const handle = {
    stat: async () => ({ isFile: () => true, size: 1024 * 1024, mtimeMs: 1 }),
    createReadStream: () => stream,
  };
  const result = await hashOpenedFile(handle, new Date(cutoff), controller.signal);
  assert.equal(result.status, FILE_OBSERVATION_STATUS.hash_interrupted);
  assert.equal(result.errorCode, INVENTORY_ERROR_CODES.hash_interrupted);
});

test("reports interrupted hashes and enforces Windows path boundaries", async () => {
  const controller = new AbortController();
  controller.abort();
  const handle = { stat: async () => ({ isFile: () => true, size: 10, mtimeMs: 1 }), createReadStream: () => { throw new Error("must not read"); } };
  const result = await hashOpenedFile(handle, new Date(cutoff), controller.signal);
  assert.equal(result.status, FILE_OBSERVATION_STATUS.hash_interrupted);
  assert.equal(result.errorCode, INVENTORY_ERROR_CODES.hash_interrupted);
  assert.equal(isPathWithin("C:\\data\\root", "C:\\data\\root\\file.txt", "win32"), true);
  assert.equal(isPathWithin("C:\\data\\root", "C:\\data\\root-sibling\\file.txt", "win32"), false);
});

test("rejects a calendar-invalid cutoff", async () => {
  await withRoots(async ({ allowed, incoming }) => {
    await assert.rejects(
      collect({ nodeId: "node-a", incomingRoot: incoming, explicitSources: [], allowedRoots: [allowed], cutoff: "2026-02-30T00:00:00.000Z" }),
      /valid UTC ISO timestamp/,
    );
  });
});
