import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createAgentPortraitSeedSink } from "../src/node/agent_portrait_seed.js";
import { createFakeAgentPortraits } from "./fake_agent_portraits.js";

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from("seed")]);
const pngSha = createHash("sha256").update(png).digest("hex");

function setup(agents: unknown[], initial: Parameters<typeof createFakeAgentPortraits>[0] = []) {
  const portraits = createFakeAgentPortraits(initial);
  const warn = vi.fn();
  const sink = createAgentPortraitSeedSink({
    portraits,
    registry: { getConnectedNode: () => ({ nodeId: "node-a", agents }) as never },
    warn,
  });
  return { portraits, warn, sink };
}

const registered = [{ type: "node_registered", nodeId: "node-a", connectionId: "c1" }] as never;

describe("agent portrait seed from node registration", () => {
  it("seeds a missing agent from portrait_b64 as source node bytes", async () => {
    const { portraits, sink } = setup([{ id: "blossom", portrait_b64: png.toString("base64") }]);

    await sink(registered);

    expect(portraits.summary("blossom")).toMatchObject({ sha256: pngSha, mime: "image/png", byteSize: png.length });
  });

  it("also reacts to node_updated", async () => {
    const { portraits, sink } = setup([{ id: "blossom", portrait_b64: png.toString("base64") }]);

    await sink([{ type: "node_updated", nodeId: "node-a", connectionId: "c1", node: {} }] as never);

    expect(portraits.summary("blossom")).not.toBeNull();
  });

  it("ignores node copies when the central store already has a row, including a deletion marker", async () => {
    const other = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from("central")]);
    const { portraits, sink } = setup(
      [
        { id: "roselin", portrait_b64: png.toString("base64") },
        { id: "blossom", portrait_b64: png.toString("base64") },
      ],
      [{ agentId: "roselin", body: other, mime: "image/png", sha256: createHash("sha256").update(other).digest("hex") }],
    );
    await portraits.remove("blossom");

    await sink(registered);

    expect(portraits.summary("roselin")?.byteSize).toBe(other.length);
    expect(portraits.summary("blossom")).toBeNull();
  });

  it("skips bytes that fail validation and only logs a warning", async () => {
    const { portraits, warn, sink } = setup([
      { id: "bad", portrait_b64: Buffer.from("not an image").toString("base64") },
      { id: "empty", portrait_b64: "" },
    ]);

    await sink(registered);
    await sink(registered);

    expect(portraits.hasRecord("bad")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does nothing for other node events", async () => {
    const { portraits, sink } = setup([{ id: "blossom", portrait_b64: png.toString("base64") }]);

    await sink([{ type: "node_unregistered", nodeId: "node-a", connectionId: "c1", reason: "x" }] as never);

    expect(portraits.hasRecord("blossom")).toBe(false);
  });
});
