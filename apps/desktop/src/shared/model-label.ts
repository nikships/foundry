/** A stable, readable label for an opaque provider/model id. */
export function modelLabel(id: string | null | undefined): string {
  if (!id) return 'inherit';
  const custom = id.match(/^custom:[^:]+:(.+)$/);
  const label = custom ? custom[1]! : id;
  const providerSeparator = label.indexOf('/');
  return providerSeparator >= 0 ? label.slice(providerSeparator + 1) : label;
}
