const PAGE_SIZE_PATTERN = /page size of (\d+) bytes/;
const PAGE_COUNT_PATTERNS = [
  /^Pages free:[ \t]+(\d+)\.?[ \t]*$/m,
  /^Pages inactive:[ \t]+(\d+)\.?[ \t]*$/m,
  /^Pages purgeable:[ \t]+(\d+)\.?[ \t]*$/m,
];

/**
 * Parses `vm_stat` output into available bytes.
 *
 * `os.freemem()` only counts free pages on Darwin and hides file cache and
 * inactive pages, so the server derives its own value from free, inactive and
 * purgeable pages multiplied by the page size reported in the first line.
 * Returns undefined when the output has no usable page size or any required
 * counter, which lets the collector fall back to `freemem()`.
 */
export function parseDarwinAvailableMemory(output: string): number | undefined {
  const [header] = output.split(/\r?\n/, 1);
  if (!header) return undefined;
  const pageSizeMatch = PAGE_SIZE_PATTERN.exec(header);
  if (!pageSizeMatch) return undefined;
  const pageSize = Number(pageSizeMatch[1]);
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) return undefined;

  let pageCount = 0;
  for (const pattern of PAGE_COUNT_PATTERNS) {
    const match = pattern.exec(output);
    if (!match) return undefined;
    const count = Number(match[1]);
    if (!Number.isSafeInteger(count) || count < 0) return undefined;
    pageCount += count;
  }
  return pageCount * pageSize;
}
