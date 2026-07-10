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
  await writeFile(join(directory, "assets", "app.js"), "console.log('asset')");
  return directory;
}
