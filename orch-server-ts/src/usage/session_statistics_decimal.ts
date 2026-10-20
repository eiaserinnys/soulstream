export type Decimal = { coefficient: bigint; scale: number };

export function parseDecimal(value: string): Decimal {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new Error("session statistics cost decimal is invalid");
  const fraction = match[3] ?? "";
  const sign = match[1] === "-" ? "-" : "";
  return { coefficient: BigInt(`${sign}${match[2]}${fraction}`), scale: fraction.length };
}

function align(left: Decimal, right: Decimal): { left: bigint; right: bigint; scale: number } {
  const scale = Math.max(left.scale, right.scale);
  return {
    left: left.coefficient * 10n ** BigInt(scale - left.scale),
    right: right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  };
}

export function addDecimal(total: Decimal | null, next: Decimal): Decimal {
  if (total === null) return next;
  const aligned = align(total, next);
  return { coefficient: aligned.left + aligned.right, scale: aligned.scale };
}

export function subtractDecimal(left: Decimal, right: Decimal): Decimal {
  const aligned = align(left, right);
  return { coefficient: aligned.left - aligned.right, scale: aligned.scale };
}

export function compareDecimal(left: Decimal, right: Decimal): number {
  const aligned = align(left, right);
  return aligned.left < aligned.right ? -1 : aligned.left > aligned.right ? 1 : 0;
}

export function decimalNumber(value: Decimal | null): number | null {
  return value === null ? null : Number(value.coefficient) / 10 ** value.scale;
}

export function decimalString(value: Decimal | null): string | null {
  if (value === null) return null;
  const negative = value.coefficient < 0n;
  const digits = (negative ? -value.coefficient : value.coefficient).toString().padStart(value.scale + 1, "0");
  const split = digits.length - value.scale;
  return `${negative ? "-" : ""}${digits.slice(0, split)}${value.scale ? `.${digits.slice(split)}` : ""}`;
}
