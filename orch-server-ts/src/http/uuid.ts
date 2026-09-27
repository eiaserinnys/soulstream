const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_RFC4122_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown, version?: 4 | "rfc4122"): value is string {
  if (typeof value !== "string") return false;
  const pattern = version === 4
    ? UUID_V4_RE
    : version === "rfc4122"
      ? UUID_RFC4122_RE
      : UUID_RE;
  return pattern.test(value);
}
