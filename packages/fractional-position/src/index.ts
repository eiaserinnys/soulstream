const POSITION_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MIN_DIGIT = POSITION_ALPHABET[0]!;
const MIDDLE_DIGIT =
  POSITION_ALPHABET[Math.floor(POSITION_ALPHABET.length / 2)]!;

const charToIndex = new Map(
  Array.from(POSITION_ALPHABET, (char, index) => [char, index] as const),
);

function normalizeBound(value: string | null, name: string): string | null {
  if (value === null) return null;
  if (value.length === 0) {
    throw new Error(`${name} must be null or a non-empty position key`);
  }
  for (const char of value) {
    if (!charToIndex.has(char)) {
      throw new Error(`${name} contains an invalid position key character: ${char}`);
    }
  }
  return value;
}

function digitIndex(char: string): number {
  const index = charToIndex.get(char);
  if (index === undefined) {
    throw new Error(`invalid position key character: ${char}`);
  }
  return index;
}

function generateKeyBefore(upper: string): string {
  let prefix = "";
  for (const char of upper) {
    const upperIndex = digitIndex(char);
    if (upperIndex > 1) {
      return prefix + POSITION_ALPHABET[Math.floor(upperIndex / 2)]!;
    }
    if (upperIndex === 1) {
      return prefix + MIN_DIGIT + MIDDLE_DIGIT;
    }
    prefix += char;
  }
  throw new Error("cannot generate a position key before the minimum key");
}

function generateKeyAfter(lower: string): string {
  let prefix = "";
  const maxIndex = POSITION_ALPHABET.length - 1;
  for (const char of lower) {
    const lowerIndex = digitIndex(char);
    if (lowerIndex < maxIndex - 1) {
      return prefix + POSITION_ALPHABET[Math.ceil((lowerIndex + maxIndex) / 2)]!;
    }
    if (lowerIndex === maxIndex - 1) {
      return prefix + POSITION_ALPHABET[maxIndex]! + MIDDLE_DIGIT;
    }
    prefix += char;
  }
  return lower + MIDDLE_DIGIT;
}

/**
 * Generate a lexicographic fractional position key strictly between two bounds.
 *
 * Bounds must be ordered with normal string comparison. Null means open-ended.
 * The function never falls back to integer positions or renumbers neighbors.
 */
export function generateKeyBetween(
  a: string | null,
  b: string | null,
): string {
  const lower = normalizeBound(a, "a");
  const upper = normalizeBound(b, "b");

  if (lower !== null && upper !== null && lower >= upper) {
    throw new Error("a must sort before b");
  }

  if (lower === null) {
    if (upper === null) return MIDDLE_DIGIT;
    return generateKeyBefore(upper);
  }
  if (upper === null) return generateKeyAfter(lower);

  let prefix = "";
  for (let index = 0; index < lower.length || index < upper.length; index += 1) {
    if (index >= lower.length) {
      return lower + generateKeyBefore(upper.slice(index));
    }
    if (index >= upper.length) {
      throw new Error("a must sort before b");
    }

    const lowerChar = lower[index]!;
    const upperChar = upper[index]!;
    const lowerDigit = digitIndex(lowerChar);
    const upperDigit = digitIndex(upperChar);
    if (lowerDigit === upperDigit) {
      prefix += lowerChar;
      continue;
    }

    if (upperDigit - lowerDigit > 1) {
      return prefix + POSITION_ALPHABET[Math.floor((lowerDigit + upperDigit) / 2)]!;
    }

    return lower + MIDDLE_DIGIT;
  }

  throw new Error("a must sort before b");
}
