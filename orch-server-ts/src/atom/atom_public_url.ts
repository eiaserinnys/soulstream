// Browser-facing atom address for the dashboard. ATOM_SERVER_URL is the server-to-server address
// and stays untouched; this decides what a browser can open (GET /api/status atom_public_url).

export type AtomPublicUrlInput = {
  readonly atomEnabled: boolean;
  readonly atomServerUrl: string | null | undefined;
  readonly atomPublicUrl: string | null | undefined;
};

/** Parses an http(s) absolute URL and returns it without trailing slashes, or null. */
function parseHttpUrl(raw: string): { readonly value: string; readonly hostname: string } | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return { value: trimmed.replace(/\/+$/, ""), hostname: url.hostname };
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/**
 * Order: atom disabled -> null; non-empty ATOM_PUBLIC_URL -> that value (null with onInvalid when it
 * is not an http(s) absolute URL); non-loopback ATOM_SERVER_URL -> that value; otherwise null.
 */
export function resolveAtomPublicUrl(
  input: AtomPublicUrlInput,
  onInvalid?: (value: string) => void,
): string | null {
  if (!input.atomEnabled) return null;

  const explicit = (input.atomPublicUrl ?? "").trim();
  if (explicit.length > 0) {
    const parsed = parseHttpUrl(explicit);
    if (parsed === null) {
      onInvalid?.(explicit);
      return null;
    }
    return parsed.value;
  }

  const server = parseHttpUrl(input.atomServerUrl ?? "");
  if (server === null || isLoopbackHost(server.hostname)) return null;
  return server.value;
}

/** Wraps resolveAtomPublicUrl so an invalid ATOM_PUBLIC_URL is warned about once per distinct value. */
export function createAtomPublicUrlResolver(
  warn: (message: string) => void = (message) => console.warn(message),
): (input: AtomPublicUrlInput) => string | null {
  const warned = new Set<string>();
  return (input) =>
    resolveAtomPublicUrl(input, (value) => {
      if (warned.has(value)) return;
      warned.add(value);
      warn(`ATOM_PUBLIC_URL ignored: not an http(s) absolute URL: ${value}`);
    });
}
