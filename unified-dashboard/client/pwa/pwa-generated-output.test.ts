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
    expect(sw).not.toContain('brand-icons/');
    const index = JSON.parse(await readFile(join(outDir, 'brand-icons/index.json'), 'utf8'));
    expect(index).toEqual(expect.arrayContaining([expect.objectContaining({ slug: 'github', title: 'GitHub', hex: expect.any(String) })]));
    expect(index).toEqual(expect.arrayContaining([expect.objectContaining({ slug: 'backstage_casting' })]));
    expect(await readFile(join(outDir, 'brand-icons/icons/backstage_casting.svg'), 'utf8')).toContain('<svg');
    const html = await readFile(join(outDir, 'index.html'), 'utf8');
    const entries = [...html.matchAll(/(?:src|href)="(\/assets\/[^" ]+\.js)"/g)].map(match => match[1]);
    const github = await readFile(join(outDir, 'brand-icons/icons/github.svg'), 'utf8');
    const pathData = /d="([^"]+)"/.exec(github)?.[1];
    expect(pathData).toBeTruthy();
    const pending = [...entries]; const visited = new Set<string>();
    while (pending.length) {
      const asset = pending.pop()!;
      if (visited.has(asset)) continue;
      visited.add(asset);
      const source = await readFile(join(outDir, asset.replace(/^\//, '')), 'utf8');
      expect(source).not.toContain('simple-icons');
      expect(source).not.toContain(pathData!);
      for (const match of source.matchAll(/\b(?:import|export)\s*(?:[^"']*?\sfrom\s*)?["'](\.\/[^"']+\.js)["']/g)) pending.push(`/assets/${match[1].slice(2)}`);
    }
  }, 120_000);
});
