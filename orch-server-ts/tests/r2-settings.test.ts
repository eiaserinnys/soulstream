import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerR2SettingsRoutes } from "../src/admin/r2_settings_routes.js";
import { readR2Settings, updateR2Settings, r2SettingsMetadata, normalizeR2Fields } from "../src/system/r2_settings.js";
import { createApp } from "../src/app.js";
import { parseOrchServerConfig } from "../src/config.js";
import { checkR2Bucket, createR2BoardAssetStorage } from "../src/runtime/live_board_asset_storage.js";
import { createR2StorageResolver } from "../src/runtime/r2_storage_resolver.js";

const endpoint = `https://${"a".repeat(32)}.r2.cloudflarestorage.com`;
const fields = { endpoint, bucket: "private-files", accessKeyId: "access", secretAccessKey: "SECRET_SENTINEL" };
afterEach(() => vi.unstubAllGlobals());

function database() {
  const values = new Map<string, any>(["board_r2", "attachment_r2"].map(key => [key, { setting_key: key, value: { endpoint: "", bucket: "", accessKeyId: "", secretAccessKey: "" }, version: 1 }]));
  const sql: any = vi.fn(async (strings: TemplateStringsArray, ...args: any[]) => {
    const text = strings.join("?");
    if (text.includes("UPDATE system_settings")) {
      const [value, secret, , updatedBy, key, version] = args;
      const row = values.get(key);
      if (row?.version !== version) return [];
      row.value = { ...value, secretAccessKey: secret === null ? row.value.secretAccessKey : secret };
      row.version++; row.updated_by = updatedBy;
      return [structuredClone(row)];
    }
    return values.has(args[0]) ? [structuredClone(values.get(args[0]))] : [];
  });
  sql.json = (value: unknown) => value;
  return { sql, values };
}

describe("central R2 settings", () => {
  it("matches the botocore multipart presign vector with mixed-case query keys", async () => {
    // Independent vector: botocore 1.40.61 S3SigV4QueryAuth, s3/auto, expires=3600,
    // AWSRequest(PUT, endpoint + '/private-files/file', params={partNumber:'1',
    // uploadId:'Upload-A+/=', 'X-Amz-Content-Sha256':'UNSIGNED-PAYLOAD'}).
    // Credentials('AKIDEXAMPLE', 'EXAMPLE_TEST_SECRET'); get_current_datetime fixed below.
    // https://github.com/boto/botocore/blob/1.40.61/botocore/auth.py
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "<InitiateMultipartUploadResult><UploadId>Upload-A+/=</UploadId></InitiateMultipartUploadResult>",
    )));
    try {
      const storage = createR2BoardAssetStorage({ ...fields,
        accessKeyId: "AKIDEXAMPLE", secretAccessKey: "EXAMPLE_TEST_SECRET" });
      const upload = await storage.createMultipartUpload({ storageKey: "file",
        mimeType: "application/octet-stream", byteSize: 1, partSize: 16 * 1024 ** 2, expiresSeconds: 3600 });
      const url = new URL(upload.parts[0]!.uploadUrl);
      expect(url.searchParams.get("X-Amz-Signature")).toBe(
        "9d18a75de62013bf25955b633fccc53a5f8b69b67375a466d54c476f2c9c601e",
      );
      url.searchParams.delete("X-Amz-Signature");
      expect(url.search.slice(1)).toBe([
        "X-Amz-Algorithm=AWS4-HMAC-SHA256", "X-Amz-Content-Sha256=UNSIGNED-PAYLOAD",
        "X-Amz-Credential=AKIDEXAMPLE%2F20261002%2Fauto%2Fs3%2Faws4_request",
        "X-Amz-Date=20261002T000000Z", "X-Amz-Expires=3600", "X-Amz-SignedHeaders=host",
        "partNumber=1", "uploadId=Upload-A%2B%2F%3D",
      ].join("&"));
    } finally { vi.useRealTimers(); }
  });
  it("uses the SigV4 authorization scheme followed by a space for HeadBucket", async () => {
    const fetchMock = vi.fn(async (_url: URL, _init: RequestInit) => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await checkR2Bucket(fields);
    const authorization = new Headers(fetchMock.mock.calls[0]![1].headers).get("authorization");
    expect(authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=access\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/);
  });
  it("keeps board and attachment independent and retains, replaces, deletes secrets with CAS", async () => {
    const { sql } = database();
    let saved = await updateR2Settings(sql, "board", { ...fields, expectedVersion: 1, updatedBy: "admin@example.com" });
    expect(r2SettingsMetadata(saved)).toEqual({ endpoint, bucket: fields.bucket, accessKeyId: "access", secretAccessKeyConfigured: true, version: 2 });
    expect(JSON.stringify(r2SettingsMetadata(saved))).not.toContain(fields.secretAccessKey);
    saved = await updateR2Settings(sql, "board", { ...fields, secretAccessKey: undefined, expectedVersion: 2, updatedBy: "admin@example.com" });
    expect(saved.secretAccessKey).toBe(fields.secretAccessKey);
    await expect(updateR2Settings(sql, "board", { ...fields, expectedVersion: 2, updatedBy: "admin@example.com" })).rejects.toMatchObject({ statusCode: 409 });
    saved = await updateR2Settings(sql, "board", { ...fields, secretAccessKey: "replacement", expectedVersion: 3, updatedBy: "admin@example.com" });
    expect(saved.secretAccessKey).toBe("replacement");
    saved = await updateR2Settings(sql, "board", { ...fields, secretAccessKey: "", expectedVersion: 4, updatedBy: "admin@example.com" });
    expect(r2SettingsMetadata(saved).secretAccessKeyConfigured).toBe(false);
    expect((await readR2Settings(sql, "attachment")).version).toBe(1);
  });
  it.each(["http://127.0.0.1", "https://evil.example", `${endpoint}.evil.example`, `${endpoint}/bucket`, `${endpoint}?token=x`, `${endpoint}#x`, endpoint.replace("https://", "https://user:pass@"), `${endpoint}:8443`])("rejects unsafe endpoint %s without echoing input", url => {
    expect(() => normalizeR2Fields({ ...fields, endpoint: url })).toThrow("Endpoint");
    try { normalizeR2Fields({ ...fields, endpoint: url }); } catch (error) { expect(String(error)).not.toContain(url); }
  });
  it("resolves fresh DB credentials for signed upload/download and read-only checks", async () => {
    const { sql } = database();
    const resolver = createR2StorageResolver(async () => sql);
    expect(await resolver.resolve("attachment")).toBeNull();
    expect(await resolver.check("attachment")).toMatchObject({ status: "not_configured" });
    await updateR2Settings(sql, "board", { ...fields, expectedVersion: 1, updatedBy: "admin@example.com" });
    const first = await resolver.resolve("board");
    expect(await first!.createPresignedPutUrl({ storageKey: "file", mimeType: "image/png", expiresSeconds: 60 })).toContain("access%2F");
    await updateR2Settings(sql, "board", { ...fields, accessKeyId: "new-access", expectedVersion: 2, updatedBy: "admin@example.com" });
    const second = await resolver.resolve("board");
    expect(await second!.createPresignedGetUrl({ storageKey: "file", expiresSeconds: 60 })).toContain("new-access%2F");
    const fetchMock = vi.fn(async (_url: URL, _init: RequestInit) => new Response(null, { status: 200 })); vi.stubGlobal("fetch", fetchMock);
    expect(await resolver.check("board")).toMatchObject({ status: "ok" });
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: "HEAD", redirect: "error" });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${endpoint}/private-files`);
    fetchMock.mockRejectedValueOnce(new Error(fields.secretAccessKey));
    expect(JSON.stringify(await resolver.check("board"))).not.toContain(fields.secretAccessKey);
  });
  it("does not expose secret request bodies or provider errors in production responses and logs", async () => {
    const chunks: string[] = [];
    const app = createApp({ config: parseOrchServerConfig({ environment: "production", databaseUrl: "postgres://test@localhost/test_db", authBearerToken: "service" }),
      logDestination: { write: message => chunks.push(message) },
      r2SettingsRoutes: { currentEmail: async () => "admin@example.com", isAdminEmail: async () => true,
        getSettings: async () => { throw new Error(fields.secretAccessKey); }, updateSettings: async () => { throw new Error(fields.secretAccessKey); }, check: async () => { throw new Error(fields.secretAccessKey); } } });
    for (const method of ["GET", "PUT", "POST"] as const) {
      const response = await app.inject({ method, url: `/api/admin/settings/board-r2${method === "POST" ? "/check" : ""}`, ...(method === "PUT" ? { payload: { ...fields, expectedVersion: 1 } } : {}) });
      expect(response.body).not.toContain(fields.secretAccessKey);
    }
    const malformed = await app.inject({ method: "PUT", url: "/api/admin/settings/board-r2", headers: { "content-type": "application/json" }, payload: `{"secretAccessKey":"${fields.secretAccessKey}" invalid}` });
    expect(malformed.statusCode).toBe(400); expect(malformed.body).not.toContain(fields.secretAccessKey);
    app.log.info({ body: { secretAccessKey: fields.secretAccessKey } }, "masking probe");
    await app.close(); expect(chunks.join("")).not.toContain(fields.secretAccessKey); expect(chunks.join("")).toContain("[Redacted]");
  });

  it.each(["board", "attachment"] as const)("protects all %s routes and returns only safe metadata/errors", async purpose => {
    const { sql } = database();
    const resolver = createR2StorageResolver(async () => sql);
    let admin = true;
    const app = Fastify();
    registerR2SettingsRoutes(app, { currentEmail: async () => "admin@example.com", isAdminEmail: async () => admin,
      getSettings: p => readR2Settings(sql, p), updateSettings: (p, input) => updateR2Settings(sql, p, input), check: resolver.check });
    const url = `/api/admin/settings/${purpose}-r2`;
    expect((await app.inject({ method: "PUT", url, payload: fields })).statusCode).toBe(422);
    const put = await app.inject({ method: "PUT", url, payload: { ...fields, expectedVersion: 1 } });
    expect(put.statusCode).toBe(200); expect(put.body).not.toContain(fields.secretAccessKey);
    const get = await app.inject({ method: "GET", url });
    expect(get.json()).toEqual(put.json());
    expect((await app.inject({ method: "PUT", url, payload: { ...fields, expectedVersion: 1 } })).statusCode).toBe(409);
    admin = false;
    for (const [method, path] of [["GET", url], ["PUT", url], ["POST", `${url}/check`]] as const) expect((await app.inject({ method, url: path })).statusCode).toBe(403);
    await app.close();
  });
});
