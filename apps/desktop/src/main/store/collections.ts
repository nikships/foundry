/**
 * List helpers shared by the domain stores. Every store holds a JSON array
 * keyed by a name or id, so upsert-by-key and copy naming are the same two
 * operations in each of them.
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
