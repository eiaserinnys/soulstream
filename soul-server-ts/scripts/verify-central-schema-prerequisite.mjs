const HEALTH_PATH = "/api/health";

export async function verifyCentralSchemaPrerequisite({
  upstreamUrl,
  schemaGeneration,
  fetchImpl = fetch,
}) {
  const required = parseSchemaGeneration(schemaGeneration);
  const response = await fetchImpl(centralHealthUrl(upstreamUrl), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(
      `central database schema prerequisite mismatch: health returned ${response.status}`,
    );
  }
  const body = await response.json();
  const actual = body?.database_schema;
  if (
    body?.status !== "ok"
    || actual?.migration_id !== required.migrationId
    || actual?.checksum !== required.checksum
  ) {
    throw new Error(
      "central database schema prerequisite mismatch: target migration is not active",
    );
  }
  return actual;
}

function parseSchemaGeneration(value) {
  if (typeof value !== "string") {
    throw new Error("release manifest schema_generation is required");
  }
  const [migrationId, checksum] = value.split(":", 3);
  if (!migrationId || !checksum) {
    throw new Error("release manifest schema_generation is malformed");
  }
  return { migrationId, checksum };
}

function centralHealthUrl(upstreamUrl) {
  const url = new URL(upstreamUrl);
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  else throw new Error("SOULSTREAM_UPSTREAM_URL must be ws:// or wss://");
  url.pathname = HEALTH_PATH;
  url.search = "";
  url.hash = "";
  return url;
}
