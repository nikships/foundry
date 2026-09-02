/**
 * List helpers shared by the domain stores. Every store holds a JSON array
 * keyed by a name or id, so upsert-by-key, copy naming, and builtin seeding
 * are the same operations in each of them.
 */

/** Replaces the first match in place, or appends when there is none. */
export function upsertBy<T>(list: T[], match: (item: T) => boolean, value: T): T[] {
  const index = list.findIndex(match);
  if (index < 0) return [...list, value];
  const copy = [...list];
  copy[index] = value;
  return copy;
}

/** `name-copy`, then `name-copy-2`, `name-copy-3`, … until one is free. */
export function uniqueCopyName(base: string, existing: Set<string>): string {
  let candidate = `${base}-copy`;
  let n = 2;
  while (existing.has(candidate)) candidate = `${base}-copy-${n++}`;
  return candidate;
}

/**
 * Restore any shipped document missing from a stored list, and drop `builtin`
 * from names/ids this build does not ship — a fork must not inherit that flag.
 */
export function seedBuiltins<T extends { builtin?: boolean }>(
  list: T[],
  builtins: readonly T[],
  key: (item: T) => string,
): T[] {
  const shipped = new Set(builtins.map(key));
  const byKey = new Map<string, T>();
  for (const item of list) {
    const id = key(item);
    byKey.set(id, shipped.has(id) ? item : ({ ...item, builtin: false } as T));
  }
  for (const builtin of builtins) {
    const id = key(builtin);
    if (!byKey.has(id)) byKey.set(id, { ...builtin });
  }
  return [...byKey.values()];
}
