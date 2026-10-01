export function mapRecord<T>(
  record: Record<string, T>,
  transform: (value: T, key: string) => T,
): Record<string, T> {
  let next: Record<string, T> | null = null;
  for (const [key, value] of Object.entries(record)) {
    const transformed = transform(value, key);
    if (transformed !== value) {
      next ??= { ...record };
      next[key] = transformed;
    }
  }
  return next ?? record;
}

export function mapIfChanged<T>(items: T[], transform: (item: T) => T): T[] {
  let next: T[] | null = null;
  items.forEach((item, index) => {
    const transformed = transform(item);
    if (transformed !== item) {
      next ??= [...items];
      next[index] = transformed;
    }
  });
  return next ?? items;
}

export function replaceById<T>(items: T[], replacement: T, key: (item: T) => string): T[] {
  const id = key(replacement);
  return mapIfChanged(items, (item) => key(item) === id ? replacement : item);
}

export function upsertById<T>(items: T[], replacement: T, key: (item: T) => string): T[] {
  const replaced = replaceById(items, replacement, key);
  return replaced.some((item) => key(item) === key(replacement))
    ? replaced
    : [...items, replacement];
}

export function removeById<T>(items: T[], id: string, key: (item: T) => string): T[] {
  return items.some((item) => key(item) === id)
    ? items.filter((item) => key(item) !== id)
    : items;
}
