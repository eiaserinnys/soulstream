import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

import { ConfigStore } from "../src/config_store.js";

const TestConfigSchema = z.object({
  agents: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
  })).default([]),
});

type TestConfig = z.infer<typeof TestConfigSchema>;

function makeStore(
  configPath: string,
  snapshotRoot: string,
  onAfterApply = vi.fn(),
): ConfigStore<TestConfig> {
  return new ConfigStore({
    configPath,
    snapshotRoot,
    parse: (raw) => TestConfigSchema.parse(parseYaml(raw) ?? {}),
    stringify: (config) => stringifyYaml(TestConfigSchema.parse(config)),
    onAfterApply,
  });
}

describe("ConfigStore", () => {
  let tempDir: string;
  let configPath: string;
  let snapshotRoot: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-store-"));
    configPath = path.join(tempDir, "agents.yaml");
    snapshotRoot = path.join(tempDir, ".local", "config-snapshots");
    fs.writeFileSync(
      configPath,
      [
        "# Existing comments are intentionally not preserved by ConfigStore.",
        "agents:",
        "  - id: a",
        "    name: A",
        "",
      ].join("\n"),
      "utf-8",
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("plans a validated diff without writing snapshots", async () => {
    const store = makeStore(configPath, snapshotRoot);

    const plan = await store.plan((current) => ({
      ...current,
      agents: [...current.agents, { id: "b", name: "B" }],
    }));

    expect(plan.changed).toBe(true);
    expect(plan.diff).toContain("--- agents.yaml");
    expect(plan.diff).toContain("+  - id: b");
    expect(plan.commentPreservation).toBe("not_preserved");
    expect(fs.existsSync(snapshotRoot)).toBe(false);
    expect(fs.readFileSync(configPath, "utf-8")).toContain("# Existing comments");
  });

  it("applies with a pre-write snapshot, atomic replacement, and reload hook", async () => {
    const onAfterApply = vi.fn();
    const store = makeStore(configPath, snapshotRoot, onAfterApply);

    const result = await store.apply((current) => ({
      ...current,
      agents: [{ id: "a", name: "A2" }],
    }));

    expect(result.changed).toBe(true);
    expect(result.snapshotPath).toBeTruthy();
    expect(fs.existsSync(result.snapshotPath ?? "")).toBe(true);
    expect(fs.readFileSync(result.snapshotPath ?? "", "utf-8")).toContain("name: A");
    expect(fs.readFileSync(configPath, "utf-8")).toContain("name: A2");
    expect(fs.readFileSync(configPath, "utf-8")).not.toContain("# Existing comments");
    expect(onAfterApply).toHaveBeenCalledWith({
      agents: [{ id: "a", name: "A2" }],
    });
  });

  it("rolls back from a managed snapshot and snapshots the replaced current file", async () => {
    const onAfterApply = vi.fn();
    const store = makeStore(configPath, snapshotRoot, onAfterApply);
    const applied = await store.apply((current) => ({
      ...current,
      agents: [{ id: "a", name: "A2" }],
    }));

    const rollback = await store.rollback(applied.snapshotPath ?? "");

    expect(rollback.changed).toBe(true);
    expect(rollback.snapshotPath).not.toBe(applied.snapshotPath);
    expect(fs.readFileSync(rollback.snapshotPath ?? "", "utf-8")).toContain("name: A2");
    expect(fs.readFileSync(configPath, "utf-8")).toContain("name: A");
    expect(onAfterApply).toHaveBeenLastCalledWith({
      agents: [{ id: "a", name: "A" }],
    });
  });

  it("rejects rollback paths outside the managed snapshot directory", async () => {
    const store = makeStore(configPath, snapshotRoot);
    const outside = path.join(tempDir, "outside.yaml");
    fs.writeFileSync(outside, "agents: []\n", "utf-8");

    await expect(store.rollback(outside)).rejects.toThrow(/outside snapshot root/);
  });
});
