/** Joins class names, dropping the falsy ones a conditional class produces. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
