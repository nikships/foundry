export function linearStateColor(type: string): string {
  if (type === 'started') return 'var(--amber)';
  if (type === 'completed') return 'var(--green)';
  if (type === 'canceled' || type === 'cancelled') return 'var(--text-faint)';
  if (type === 'backlog') return 'var(--text-ghost)';
  return 'var(--text-dim)';
}
