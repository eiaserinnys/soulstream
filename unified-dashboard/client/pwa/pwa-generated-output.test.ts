import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { build } from "vite";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const outputs: string[] = [];

afterEach(async () => {
  await Promise.all(outputs.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("generated dashboard service worker", () => {
  it("claims clients, activates immediately, and keeps the HTML shell network-first", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "soulstream-pwa-"));
    outputs.push(outDir);
    await build({
      root: packageRoot,
      configFile: join(packageRoot, "vite.config.ts"),
      logLevel: "silent",
      build: { outDir, emptyOutDir: true },
    });

    const sw = await readFile(join(outDir, "sw.js"), "utf8");
    expect(sw).toContain('importScripts("/sw-update-migration.js")');
    expect(sw).toContain("self.skipWaiting()");
    expect(sw).toContain("clientsClaim()");
    expect(sw).toContain("NetworkFirst");
    expect(sw).toMatch(
      /\b["']?cacheName["']?\s*:\s*["']soulstream-navigation-v1["']/,
    );
    expect(sw).not.toMatch(/\b["']?url["']?\s*:\s*["']index\.html["']/);
    expect(sw).not.toMatch(/\b["']?url["']?\s*:\s*["']registerSW\.js["']/);
    expect(sw).not.toMatch(/\b["']?url["']?\s*:\s*["']sw-update-migration\.js["']/);
  }, 120_000);
});
