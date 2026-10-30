export type Position = { ordinal: number; id: number };
export function formatPosition(ordinal: number, id: number): string {
  return ordinal === 0 ? String(id) : `${ordinal}:${id}`;
}
export function parsePosition(value: string): Position | undefined {
  const match = /^(?:(\d+):)?(\d+)$/.exec(value);
  if (!match) return undefined;
  const ordinal = Number(match[1] ?? 0), id = Number(match[2]);
  if (!Number.isSafeInteger(ordinal) || !Number.isSafeInteger(id)) return undefined;
  if (match[1] !== undefined && ordinal === 0) return undefined;
  return { ordinal, id };
}
export function comparePosition(a: Position, b: Position): number {
  return a.ordinal - b.ordinal || a.id - b.id;
}
