import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerDashboardServing } from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("dashboard static serving", () => {
  it("serves the iOS bundle index with revalidation and hashed scripts and fonts as immutable", async () => {
    const dashboardDir = await createDashboardDirectory();
    const bundleDir = join(dashboardDir, "assets", "ios-components");
    await mkdir(join(bundleDir, "assets"), { recursive: true });
    await writeFile(join(bundleDir, "index.html"), "<html>public-app-samples</html>");
    await writeFile(join(bundleDir, "assets", "app-a123.js"), "console.log('samples')");
    await writeFile(join(bundleDir, "assets", "icons-a123.ttf"), "font-fixture");
    const app = Fastify();
    await registerDashboardServing(app, { dashboardDir });

    const index = await app.inject("/assets/ios-components/index.html");
    expect(index.statusCode).toBe(200);
    expect(index.body).toBe("<html>public-app-samples</html>");
    expect(index.headers["content-type"]).toMatch(/^text\/html/);
    expect(index.headers["cache-control"]).toBe("no-cache");
    const head = await app.inject({ method: "HEAD", url: "/assets/ios-components/index.html" });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe("");
    expect(head.headers["cache-control"]).toBe("no-cache");
    for (const [file, mime] of [["app-a123.js", "text/javascript"], ["icons-a123.ttf", "font/ttf"]]) {
      const asset = await app.inject(`/assets/ios-components/assets/${file}`);
      expect(asset.statusCode).toBe(200);
      expect(asset.headers["content-type"]).toContain(mime);
      expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    }
    for (const file of ["missing.js", "missing.ttf"]) {
      const missing = await app.inject(`/assets/ios-components/assets/${file}`);
      expect(missing.statusCode).toBe(404);
      expect(missing.body).not.toContain("<html>");
    }
    for (const route of ["/components/ios", "/components/ios/", "/components", "/"]) {
      const entry = await app.inject(route);
      expect(entry.statusCode).toBe(200);
      expect(entry.body).toBe("<html>dashboard-index</html>");
    }
    await app.close();
  });

  it("returns 404 for an absent bundle index instead of the dashboard HTML", async () => {
    const dashboardDir = await createDashboardDirectory();
    const app = Fastify();
    await registerDashboardServing(app, { dashboardDir });
    for (const method of ["GET", "HEAD"] as const) {
      const missing = await app.inject({ method, url: "/assets/ios-components/index.html" });
      expect(missing.statusCode).toBe(404);
      expect(missing.body).not.toContain("dashboard-index");
    }
    await app.close();
  });

  it("serves assets and root files before the SPA fallback without masking API paths", async () => {
    const dashboardDir = await createDashboardDirectory();
    const app = Fastify();
    app.get("/api/health", async () => ({ status: "ok" }));

    await expect(registerDashboardServing(app, { dashboardDir })).resolves.toBe(true);

    const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe("console.log('asset')");
    expect(asset.headers["content-type"]).toMatch(/^text\/javascript/);
    expect(asset.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );

    const rootFile = await app.inject({ method: "GET", url: "/registerSW.js" });
    expect(rootFile.statusCode).toBe(200);
    expect(rootFile.body).toBe("register-sw");
    expect(rootFile.headers["cache-control"]).toBe("no-cache");

    for (const rootPath of ["/sw.js", "/sw-update-migration.js", "/manifest.webmanifest"]) {
      const mutableRootFile = await app.inject({ method: "GET", url: rootPath });
      expect(mutableRootFile.statusCode).toBe(200);
      expect(mutableRootFile.headers["cache-control"]).toBe("no-cache");
    }

    const spa = await app.inject({ method: "GET", url: "/folders/alpha" });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toBe("<html>dashboard-index</html>");
    expect(spa.headers["cache-control"]).toBe("no-cache");

    const api = await app.inject({ method: "GET", url: "/api/missing" });
    expect(api.statusCode).toBe(404);
    expect(api.body).not.toContain("dashboard-index");

    const missingAsset = await app.inject({ method: "GET", url: "/assets/missing.js" });
    expect(missingAsset.statusCode).toBe(404);
    expect(missingAsset.body).not.toContain("dashboard-index");

    await app.close();
  });

  it("warns and leaves static routes unmounted when the dashboard is unset or absent", async () => {
    const warn = vi.fn();
    const app = Fastify();

    await expect(registerDashboardServing(app, { dashboardDir: "", warn })).resolves.toBe(false);
    await expect(registerDashboardServing(app, {
      dashboardDir: join(tmpdir(), "missing-soulstream-dashboard"),
      warn,
    })).resolves.toBe(false);

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/DASHBOARD_DIR/);
    expect((await app.inject({ method: "GET", url: "/folders/alpha" })).statusCode).toBe(404);

    await app.close();
  });
});

async function createDashboardDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "orch-dashboard-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, "assets"));
  await writeFile(join(directory, "index.html"), "<html>dashboard-index</html>");
  await writeFile(join(directory, "registerSW.js"), "register-sw");
  await writeFile(join(directory, "sw.js"), "service-worker");
  await writeFile(join(directory, "sw-update-migration.js"), "service-worker-migration");
  await writeFile(join(directory, "manifest.webmanifest"), "{}");
  await writeFile(join(directory, "assets", "app.js"), "console.log('asset')");
  return directory;
}
