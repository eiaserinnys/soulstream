export function estimateInputTokens(input: {
  storedTokenEstimate?: number | null;
  charsUtf16?: number | null;
}): number | null {
  if (typeof input.storedTokenEstimate === "number") {
    return input.storedTokenEstimate;
  }
  if (typeof input.charsUtf16 === "number") {
    return Math.ceil(input.charsUtf16 / 4);
  }
  return null;
}
