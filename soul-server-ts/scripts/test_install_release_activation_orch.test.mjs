import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import WebSocket from "ws";

import { startReleaseActivationOrchStub } from "./test_install_release_activation_orch.mjs";

test("test-install orch stub returns one idempotent receipt for repeated registration", async (t) => {
  const stub = await startReleaseActivationOrchStub({
    host: "127.0.0.1",
    port: 0,
    now: () => new Date("2026-08-21T08:00:00.000Z"),
  });
  t.after(async () => await stub.close());

  const socket = new WebSocket(`ws://127.0.0.1:${stub.port}/ws/node`);
  t.after(() => socket.close());
  await once(socket, "open");

  const registration = {
    type: "node_register",
    node_id: "standalone-ts",
    release_manifest: { manifest_id: "manifest-1" },
    release_activation: {
      manifest_id: "manifest-1",
      registration_idempotency_key: "registration-key",
    },
  };
  socket.send(JSON.stringify(registration));
  const [firstRaw] = await once(socket, "message");
  socket.send(JSON.stringify(registration));
  const [secondRaw] = await once(socket, "message");

  const first = JSON.parse(firstRaw.toString());
  const second = JSON.parse(secondRaw.toString());
  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    type: "node_register_ack",
    node_id: "standalone-ts",
    release_activation_receipt: {
      manifest_id: "manifest-1",
      activation_generation: 1,
      activated_at: "2026-08-21T08:00:00.000Z",
      registration_idempotency_key: "registration-key",
    },
  });
});

test("test-install orch stub rejects a registration whose manifest identities disagree", async (t) => {
  const stub = await startReleaseActivationOrchStub({ host: "127.0.0.1", port: 0 });
  t.after(async () => await stub.close());

  const socket = new WebSocket(`ws://127.0.0.1:${stub.port}/ws/node`);
  await once(socket, "open");
  socket.send(JSON.stringify({
    type: "node_register",
    node_id: "standalone-ts",
    release_manifest: { manifest_id: "manifest-a" },
    release_activation: {
      manifest_id: "manifest-b",
      registration_idempotency_key: "registration-key",
    },
  }));

  const [code, reason] = await once(socket, "close");
  assert.equal(code, 1008);
  assert.match(reason.toString(), /manifest identity mismatch/);
});
